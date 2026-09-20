/** Tailwind v4 uses a dedicated PostCSS plugin (no autoprefixer/tailwind.config needed in the chain). */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
