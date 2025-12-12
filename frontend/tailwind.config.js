module.exports = {
  content: ["./index.html", "./src/*/.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#2563EB",      // Telecom blue
        primaryDark: "#1E40AF",
        accent: "#22C55E",       // Success / active
        dark: "#0F172A",         // Nav / footer
        bg: "#F8FAFC",
        muted: "#64748B",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      borderRadius: {
        lg: "14px",
        xl: "18px",
      },
      boxShadow: {
        card: "0 12px 30px rgba(2, 6, 23, 0.08)",
      },
    },
  },
  plugins: [],
};
