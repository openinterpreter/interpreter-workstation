/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./agent/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Note: shadcn colors are defined via @theme inline in index.css
      // Only add extensions here that aren't covered by shadcn
      borderRadius: {
        content: '8px',
      },
    }
  },
  plugins: []
}
