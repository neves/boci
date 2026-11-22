declare module "jmespath" {
  const jmespath: {
    search(value: unknown, expression: string): unknown;
  };
  export default jmespath;
}
