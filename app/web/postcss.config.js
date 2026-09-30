// PostCSS for the Vite build: Tailwind, then vendor prefixes.
// (Tailwind's preflight is off; styles.css resets what it would have.)
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
