// Workers run with nodejs_compat, which provides node:buffer; only the bit the app uses is typed here
// (native base64 decoding, far cheaper on the free plan's CPU budget than a loop over atob).
declare module 'node:buffer' {
  export const Buffer: { from(data: string, encoding: 'base64'): Uint8Array };
}
