/// <reference types="vite/client" />

// CSS modules — Vite's bundler treats `.module.css` as object literals
// at runtime. The declaration here is what tsc reads in noEmit mode.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css';
