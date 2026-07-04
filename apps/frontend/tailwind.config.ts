import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-elevated": "var(--bg-elevated)",
        "bg-sunken": "var(--bg-sunken)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        border: "var(--border)",
        accent: "var(--accent)",
        "accent-fg": "var(--accent-fg)",
        success: "var(--success)",
        danger: "var(--danger)",
        warning: "var(--warning)",
      },
      keyframes: {
        "diff-glow-add": {
          "0%": { boxShadow: "0 0 0 2px var(--success)" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
        "diff-glow-remove": {
          "0%": { boxShadow: "0 0 0 2px var(--danger)" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
        "diff-glow-change": {
          "0%": { boxShadow: "0 0 0 2px var(--warning)" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
      },
      animation: {
        "diff-add": "diff-glow-add 2.5s ease-out forwards",
        "diff-remove": "diff-glow-remove 2.5s ease-out forwards",
        "diff-change": "diff-glow-change 2.5s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
