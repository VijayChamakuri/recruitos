const readProperty = Reflect.get;
const fn = () => "ok";
const Constructor = readProperty(fn, "constructor");

export const host = Constructor("return globalThis")();
