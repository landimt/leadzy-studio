declare module '*.svg' {
  const url: string;
  export default url;
}

declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.css';

declare module '*.woff?url' {
  const url: string;
  export default url;
}

/** Injected by the Vite build from package.json. */
declare const __APP_VERSION__: string;
