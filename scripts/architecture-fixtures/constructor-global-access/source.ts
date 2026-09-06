const host = (() => undefined).constructor("return globalThis")();

export const fileSystem = host.process.getBuiltinModule("node:fs");
