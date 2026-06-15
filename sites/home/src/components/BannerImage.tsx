'use client'
import Image from "next/image";
import { useState, useEffect } from "react";

interface BannerImagePropos {
    srcLight?: string
    srcDark: string
    title: string
}

export default function BannerImage({ srcLight, srcDark, title }: BannerImagePropos) {
    const [theme, setTheme] = useState<"light" | "dark">("dark");

    useEffect(() => {
        const checkTheme = () => {
        setTheme(document.body.classList.contains("light") ? "light" : "dark");
        };
        checkTheme();
        const observer = new MutationObserver(checkTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        return () => observer.disconnect();
    }, []);
  
    return (
        <Image
            key={title}
            src={theme === "light" && srcLight ? srcLight : srcDark}
            alt={title}
            fill
            className="object-cover"
            style={{ objectFit: "cover", objectPosition: "center" }}
            priority
            sizes="100vw"
        />
    )
}