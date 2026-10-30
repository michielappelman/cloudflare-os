// Vite's `?raw` imports, which the Node suite uses to read generated data and source text.
declare module "*?raw" {
  const value: string;
  export default value;
}
