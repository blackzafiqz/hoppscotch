import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import { pipe } from "fp-ts/function"
import { createRequire } from "module"

import type ivmT from "isolated-vm"

import { TestResponse, TestResult } from "~/types"
import { getTestRunnerScriptMethods, preventCyclicObjects } from "~/utils"

const nodeRequire = createRequire(import.meta.url)
const ivm = nodeRequire("isolated-vm")

// Function to recursively wrap functions in `ivm.Reference`
const getSerializedAPIMethods = (
  namespaceObj: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(namespaceObj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = getSerializedAPIMethods(value as Record<string, unknown>)
    } else if (typeof value === "function") {
      result[key] = new ivm.Reference(value)
    } else {
      result[key] = value
    }
  }

  return result
}

export const runTestScript = (
  testScript: string,
  envs: TestResult["envs"],
  response: TestResponse
): TE.TaskEither<string, TestResult> =>
  pipe(
    TE.tryCatch(
      async () => {
        const isolate: ivmT.Isolate = new ivm.Isolate()
        const context = await isolate.createContext()
        return { isolate, context }
      },
      (reason) => `Context initialization failed: ${reason}`
    ),
    TE.chain(({ isolate, context }) =>
      pipe(
        TE.tryCatch(
          async () =>
            executeScriptInContext(
              testScript,
              envs,
              response,
              isolate,
              context
            ),
          (reason) => `Script execution failed: ${reason}`
        ),
        TE.chain((result) =>
          TE.tryCatch(
            async () => {
              await isolate.dispose()
              return result
            },
            (disposeReason) => `Isolate disposal failed: ${disposeReason}`
          )
        )
      )
    )
  )
const executeScriptInContext = (
  testScript: string,
  envs: TestResult["envs"],
  response: TestResponse,
  isolate: ivmT.Isolate,
  context: ivmT.Context
): Promise<TestResult> => {
  return new Promise((resolve, reject) => {
    // Parse response object
    const responseObjHandle = preventCyclicObjects(response)
    if (E.isLeft(responseObjHandle)) {
      return reject(`Response parsing failed: ${responseObjHandle.left}`)
    }

    const jail = context.global

    const { pw, testRunStack, updatedEnvs } = getTestRunnerScriptMethods(envs)

    const serializedAPIMethods = getSerializedAPIMethods({
      ...pw,
      response: responseObjHandle.right,
    })
    jail.setSync("serializedAPIMethods", serializedAPIMethods, { copy: true })

    jail.setSync("atob", atob)
    jail.setSync("btoa", btoa)

    jail.setSync("ivm", ivm)

    // Methods in the isolate context can't be invoked straightaway
    const finalScript = `
      const pw = new Proxy(serializedAPIMethods, {
        get: (target, prop, receiver) => {
          // pw.expect(), pw.env, etc.
          const topLevelProperty = target[prop];

          // If the property exists and is a function
          // pw.expect(), pw.test(), etc.
          if (topLevelProperty && topLevelProperty.typeof === "function") {
            // pw.test() just involves invoking the function via "applySync()"
            if (prop === "test") {
              return (...args) => topLevelProperty.applySync(null, args);
            }

            // pw.expect() returns an object with matcher functions
            return (...args) => {
              // Invoke "pw.expect()" and get access to the object with matcher methods
              const resultReference = topLevelProperty.applySync(null, args.map(arg => typeof arg === "object" ? JSON.stringify(arg) : arg))

              let result = {}

              // Serialize matcher methods for use in the isolate context
              const matcherMethods = ["toBe", "toBeLevel2xx", "toBeLevel3xx", "toBeLevel4xx", "toBeLevel5xx", "toBeType", "toHaveLength", "toInclude"]
              matcherMethods.forEach((method) => {
                result[method] = new ivm.Reference(resultReference.getSync(method))
              })

              // Matcher functions that can be chained with "pw.expect()"
              // pw.expect().toBe(), etc
              if (typeof result === "object") {
                return new Proxy(result, {
                  get: (resultTarget, resultProp) => {
                    // pw.expect().not.toBe(), etc
                    if (resultProp === "not") {
                      return new Proxy(resultTarget, {
                        get: (negatedTarget, prop) => {
                          const negatedMethod = negatedTarget[prop];

                          if (negatedMethod && negatedMethod.typeof === "function") {
                            return (...resultArgs) => negatedMethod.applySync(null, resultArgs);
                          }
                          return negatedMethod;
                        }
                      })
                    }

                    const method = resultTarget[resultProp];

                    if (method && method.typeof === "function") {
                      return (...resultArgs) => method.applySync(null, resultArgs);
                    }
                    return method;
                  }
                });
              }

              return result;
            };
          }

          // "pw.env" set of API methods
          if (typeof topLevelProperty === "object" && prop !== "response") {
            // TODO: Look into possibilities of recursively apply the "receiver" Proxy handler
            return new Proxy(topLevelProperty, {
              get: (subTarget, subProp) => {
                if (subProp in subTarget && subTarget[subProp].typeof === "function") {
                  return (...args) => subTarget[subProp].applySync(null, args)
                }
              },
            })
          }

          return topLevelProperty;
        },
      });

      ${testScript}
    `

    // Create a script and compile it
    const script = isolate.compileScript(finalScript)

    // Run the test script in the provided context
    script
      .then((script) => script.run(context))
      .then(() => {
        resolve({
          tests: testRunStack,
          envs: updatedEnvs,
        })
      })
      .catch((error: Error) => {
        reject(error)
      })
  })
}
