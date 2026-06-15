"use client";

import { useEffect, useState, useRef } from "react";

export default function OwlMascot() {
  const [looking, setLooking] = useState({ x: 0, y: 0 });
  const owlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!owlRef.current) return;
      
      const rect = owlRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const dx = (e.clientX - centerX) / (window.innerWidth / 2); // Normalize -1 to 1
      const dy = (e.clientY - centerY) / (window.innerHeight / 2); // Normalize -1 to 1
      
      // Limit movement range for natural look
      const limit = 0.6;
      const x = Math.max(-limit, Math.min(limit, dx));
      const y = Math.max(-limit, Math.min(limit, dy));
      
      setLooking({ x, y });
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Pupil movement scale
  const pupilX = looking.x * 12;
  const pupilY = looking.y * 12;

  return (
    <div 
      ref={owlRef}
      className="relative w-24 h-24 flex items-center justify-center select-none transition-transform hover:scale-105"
      aria-hidden="true"
    >
      <svg 
        viewBox="0 0 100 100" 
        className="w-full h-full drop-shadow-lg"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Owl Body */}
        <circle cx="50" cy="50" r="42" className="fill-muted dark:fill-gray-200" />
        
        {/* Ears */}
        <path d="M15 25 L8 8 L30 18 Z" className="fill-muted dark:fill-gray-200" />
        <path d="M85 25 L92 8 L70 18 Z" className="fill-muted dark:fill-gray-200" />

        {/* Eyes (Sclera) */}
        <circle cx="32" cy="45" r="16" fill="white" strokeWidth="2" className="stroke-muted dark:stroke-gray-300" />
        <circle cx="68" cy="45" r="16" fill="white" strokeWidth="2" className="stroke-muted dark:stroke-gray-300" />

        {/* Pupils (Iris + Pupil) */}
        <g transform={`translate(${pupilX}, ${pupilY})`}>
          <circle cx="32" cy="45" r="6" className="fill-foreground dark:fill-gray-800" />
          <circle cx="68" cy="45" r="6" className="fill-foreground dark:fill-gray-800" />
        </g>

        {/* Beak */}
        <path d="M50 60 L44 52 L56 52 Z" className="fill-yellow-500" />
        
        {/* Wings (folded) */}
        <path d="M10 50 Q5 65 20 80" fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-muted dark:stroke-gray-300" />
        <path d="M90 50 Q95 65 80 80" fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-muted dark:stroke-gray-300" />
      </svg>
    </div>
  );
}
