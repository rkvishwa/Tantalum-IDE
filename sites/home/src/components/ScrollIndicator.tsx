"use client";

import { useEffect, useState, useCallback } from "react";

export default function ScrollIndicator() {
  const [scrollPercentage, setScrollPercentage] = useState(0);
  const [activeNodes, setActiveNodes] = useState<boolean[]>([false, false, false, false, false]);

  const updateScrollIndicator = useCallback(() => {
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    const percentage = (scrollTop / (documentHeight - windowHeight)) * 100;
    const clampedPercentage = Math.min(100, Math.max(0, percentage));

    setScrollPercentage(clampedPercentage);

    const nodePositions = [0, 25, 50, 75, 100];
    const newActiveNodes = nodePositions.map((pos) => {
      const posFromBottom = 100 - pos;
      return clampedPercentage > posFromBottom - 1;
    });
    setActiveNodes(newActiveNodes);
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", updateScrollIndicator);
    window.addEventListener("resize", updateScrollIndicator);
    updateScrollIndicator();

    return () => {
      window.removeEventListener("scroll", updateScrollIndicator);
      window.removeEventListener("resize", updateScrollIndicator);
    };
  }, [updateScrollIndicator]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const clickPercentage = (clickY / rect.height) * 100;

    const documentHeight = document.documentElement.scrollHeight;
    const windowHeight = window.innerHeight;

    const targetScrollPercentage = 100 - clickPercentage;
    const targetScroll =
      (targetScrollPercentage / 100) * (documentHeight - windowHeight);

    window.scrollTo({
      top: targetScroll,
      behavior: "smooth",
    });
  };

  const labels = ["home", "projects", "partners", "cta", "footer"];
  const positions = ["0%", "25%", "50%", "75%", "100%"];

  return (
    <div
      id="scrollProgress"
      className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:block"
    >
      <div
        className="relative h-[500px] w-0.5 cursor-pointer"
        onClick={handleClick}
      >
        {/* Background line (gray) */}
        <div className="absolute inset-0 bg-muted/30 rounded-full"></div>

        {/* Progress line (green) that fills from bottom */}
        <div
          className="absolute bottom-0 left-0 w-full bg-green-500 rounded-full transition-all duration-150 ease-out"
          style={{ height: `${scrollPercentage}%` }}
        ></div>

        {/* Section nodes */}
        {positions.map((pos, index) => (
          <div
            key={index}
            className={`absolute left-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 bg-background transition-all duration-300 ${
              activeNodes[index] ? "border-green-500" : "border-muted"
            }`}
            style={{
              top: pos,
            }}
          >
            <div
              className={`absolute inset-0.5 rounded-full bg-green-500 transition-transform duration-300 ${
                activeNodes[index] ? "scale-100" : "scale-0"
              }`}
            ></div>
          </div>
        ))}

        {/* Section labels on hover */}
        {labels.map((label, index) => (
          <div
            key={label}
            className="absolute -left-16 opacity-0 hover:opacity-100 transition-opacity mono-font text-[10px] text-muted"
            style={{ top: positions[index] }}
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
