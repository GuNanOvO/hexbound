import type { NextConfig } from 'next';

const config = {
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
} satisfies NextConfig;

export default config;
