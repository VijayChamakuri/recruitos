function localFunction(): string {
  return "value";
}

const retainedConstructor = localFunction.constructor;

export { retainedConstructor };
