"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

interface LogoIconProps {
    width?: number;
    height?: number;
    className?: string;
}

export default function LogoIcon({ width, height, className } : LogoIconProps) {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Detect theme from localStorage, system preference, or body class
    const getTheme = () => {
      if (typeof window === "undefined") return "dark";
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") return stored;
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      if (document.body.classList.contains("light")) return "light";
      return "dark";
    };
    const checkTheme = () => setTheme(getTheme());
    checkTheme();

    // Listen for body class changes
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    // Listen for storage changes (multi-tab)
    const onStorage = (e: StorageEvent) => {
      if (e.key === "theme") checkTheme();
    };
    window.addEventListener("storage", onStorage);

    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => checkTheme();
    mediaQuery.addEventListener("change", onMedia);

    return () => {
      observer.disconnect();
      window.removeEventListener("storage", onStorage);
      mediaQuery.removeEventListener("change", onMedia);
    };
  }, []);

  if (!mounted) return null;

  const src = theme === "light"
    ? "/logo/knurdz-icon-light.svg"
    : "/logo/knurdz-icon.svg";

  return (
    <Image
      key={theme}
      src={src}
      alt="Knurdz Logo"
      width={width || 220}
      height={height || 220}
      className={className || "object-contain"}
      priority
    />
  );
}
