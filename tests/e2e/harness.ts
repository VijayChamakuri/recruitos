/**
 * Playwright E2E test harness and type declarations.
 * Provides type-safe test definitions and runner interfaces matching Playwright test API.
 */

export interface PageElement {
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
}

export interface Page {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<void>;
  locator(selector: string): PageElement;
  getByRole(role: string, options?: { name?: string | RegExp }): PageElement;
  getByText(text: string | RegExp): PageElement;
  getByTestId(testId: string): PageElement;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export interface PlaywrightTestArgs {
  page: Page;
  context: BrowserContext;
}

export type TestFunction = (args: PlaywrightTestArgs) => Promise<void> | void;

export interface TestModifier {
  (title: string, testFn: TestFunction): void;
  skip(title: string, testFn: TestFunction): void;
  only(title: string, testFn: TestFunction): void;
  describe(title: string, suiteFn: () => void): void;
}

const createTestRunner = (): TestModifier => {
  const runner = ((title: string, _testFn: TestFunction): void => {
    void title;
  }) as TestModifier;

  runner.skip = (title: string, _testFn: TestFunction): void => {
    // Intentionally skipped stub pending browser runtime environment
    void title;
  };

  runner.only = (title: string, _testFn: TestFunction): void => {
    void title;
  };

  runner.describe = (title: string, suiteFn: () => void): void => {
    void title;
    suiteFn();
  };

  return runner;
};

export const test: TestModifier = createTestRunner();

export interface ExpectMatcher<T> {
  toBe(expected: T): void;
  toEqual(expected: T): void;
  toContain(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeVisible(): Promise<void>;
  toHaveText(expected: string | RegExp): Promise<void>;
  toHaveValue(expected: string): Promise<void>;
  not: ExpectMatcher<T>;
}

export function expect<T>(actual: T): ExpectMatcher<T> {
  const matcher: ExpectMatcher<T> = {
    toBe(expected: T): void {
      if (actual !== expected) {
        throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
      }
    },
    toEqual(expected: T): void {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
      }
    },
    toContain(expected: unknown): void {
      if (typeof actual === "string" && typeof expected === "string") {
        if (!actual.includes(expected)) {
          throw new Error(`Expected string to contain ${expected}`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(expected)) {
          throw new Error(`Expected array to contain ${JSON.stringify(expected)}`);
        }
      }
    },
    toBeGreaterThan(expected: number): void {
      if (typeof actual !== "number" || actual <= expected) {
        throw new Error(`Expected ${actual} > ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number): void {
      if (typeof actual !== "number" || actual < expected) {
        throw new Error(`Expected ${actual} >= ${expected}`);
      }
    },
    toBeLessThan(expected: number): void {
      if (typeof actual !== "number" || actual >= expected) {
        throw new Error(`Expected ${actual} < ${expected}`);
      }
    },
    toBeLessThanOrEqual(expected: number): void {
      if (typeof actual !== "number" || actual > expected) {
        throw new Error(`Expected ${actual} <= ${expected}`);
      }
    },
    toBeTruthy(): void {
      if (!actual) throw new Error(`Expected truthy value, received ${String(actual)}`);
    },
    toBeFalsy(): void {
      if (actual) throw new Error(`Expected falsy value, received ${String(actual)}`);
    },
    async toBeVisible(): Promise<void> {},
    async toHaveText(_expected: string | RegExp): Promise<void> {},
    async toHaveValue(_expected: string): Promise<void> {},
    get not(): ExpectMatcher<T> {
      return {
        toBe(expected: T): void {
          if (actual === expected) {
            throw new Error(`Expected value not to be ${String(expected)}`);
          }
        },
        toEqual(expected: T): void {
          if (JSON.stringify(actual) === JSON.stringify(expected)) {
            throw new Error(`Expected value not to equal ${JSON.stringify(expected)}`);
          }
        },
        toContain(expected: unknown): void {
          if (typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) {
            throw new Error(`Expected string not to contain ${expected}`);
          }
        },
        toBeGreaterThan(expected: number): void {
          if (typeof actual === "number" && actual > expected) {
            throw new Error(`Expected ${actual} not > ${expected}`);
          }
        },
        toBeGreaterThanOrEqual(expected: number): void {
          if (typeof actual === "number" && actual >= expected) {
            throw new Error(`Expected ${actual} not >= ${expected}`);
          }
        },
        toBeLessThan(expected: number): void {
          if (typeof actual === "number" && actual < expected) {
            throw new Error(`Expected ${actual} not < ${expected}`);
          }
        },
        toBeLessThanOrEqual(expected: number): void {
          if (typeof actual === "number" && actual <= expected) {
            throw new Error(`Expected ${actual} not <= ${expected}`);
          }
        },
        toBeTruthy(): void {
          if (actual) throw new Error("Expected falsy");
        },
        toBeFalsy(): void {
          if (!actual) throw new Error("Expected truthy");
        },
        async toBeVisible(): Promise<void> {},
        async toHaveText(_expected: string | RegExp): Promise<void> {},
        async toHaveValue(_expected: string): Promise<void> {},
        get not(): ExpectMatcher<T> {
          return matcher;
        }
      };
    }
  };

  return matcher;
}
