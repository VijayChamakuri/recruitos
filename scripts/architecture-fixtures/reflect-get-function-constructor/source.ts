const fn = () => "ok";
const Constructor = Reflect.get(fn, "constructor");

export const host = Constructor("return globalThis")();
