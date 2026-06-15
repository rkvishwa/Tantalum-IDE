"use client";

import { useEffect, useRef, useState } from "react";
import { Member } from "@/data/members";
import MemberAvatar from "./MemberAvatar";

interface TeamMemberPreviewProps {
    member: Member | null;
    onClose: () => void;
}

export default function TeamMemberPreview({ member, onClose }: TeamMemberPreviewProps) {
    const [isVisible, setIsVisible] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLDivElement>(null);
    const [lineCoords, setLineCoords] = useState<{ x1: number, y1: number, x2: number, y2: number } | null>(null);

    // Initial state for member change
    useEffect(() => {
        if (member) {
            // Slight delay to allow DOM to render before measuring
            const timer = setTimeout(() => {
                setIsVisible(true);
            }, 50);

            const timer2 = setTimeout(() => {
                updateCoords();
            }, 600);
            
            
            window.addEventListener('resize', updateCoords);
            return () => {
                clearTimeout(timer);
                clearTimeout(timer2);
                window.removeEventListener('resize', updateCoords);
            };
        } else {
            setIsVisible(false);
            setLineCoords(null);
        }
    }, [member]);

    const updateCoords = () => {
        if (cardRef.current && imageRef.current) {
            // Large Image (Center)
            const imgRect = imageRef.current.getBoundingClientRect();
            // Card (Top Right)
            const cardRect = cardRef.current.getBoundingClientRect();

            // Center of Image circle
            const x1 = imgRect.left + imgRect.width / 2;
            const y1 = imgRect.top + imgRect.height / 2;
            
            // Center of Card left edge
            const x2 = cardRect.left; 
            const y2 = cardRect.top + cardRect.height / 2;

            setLineCoords({ x1, y1, x2, y2 });
        }
    };

    if (!member) return null;

    return (
        <div className={`fixed inset-0 z-50 transition-colors duration-500 ${isVisible ? 'bg-background/80 backdrop-blur-sm' : 'bg-transparent pointer-events-none'}`}>
            {/* Click Outside Handler */}
            <div className="absolute inset-0 w-full h-full" onClick={onClose} />

            {/* SVG Connector Layer */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-40 overflow-visible">
                 <defs>
                    <linearGradient id="line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity="0.8" />
                        <stop offset="100%" stopColor="var(--foreground)" stopOpacity="0.4" />
                    </linearGradient>
                    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="2" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                    </filter>
                </defs>
                {/* Only render line if we have coords and visible */}
                {lineCoords && isVisible && (
                    <>
                        {/* Connecting Line */}
                        <path 
                            d={`M ${lineCoords.x1} ${lineCoords.y1} C ${lineCoords.x1 + 100} ${lineCoords.y1}, ${lineCoords.x2 - 100} ${lineCoords.y2}, ${lineCoords.x2} ${lineCoords.y2}`}
                            fill="none"
                            stroke="url(#line-gradient)"
                            strokeWidth="2"
                            strokeLinecap="round"
                            style={{
                                strokeDasharray: 1000,
                                strokeDashoffset: 1000,
                                animation: 'draw-line 1s forwards ease-out'
                            }}
                        />
                        {/* Start Node (on Image) */}
                        <circle 
                            cx={lineCoords.x1} 
                            cy={lineCoords.y1} 
                            r="6" 
                            fill="#22c55e" 
                            filter="url(#glow)"
                        />
                         {/* End Node (on Card) */}
                         <circle 
                            cx={lineCoords.x2} 
                            cy={lineCoords.y2} 
                            r="4" 
                            fill="var(--foreground)" 
                        />
                    </>
                )}
            </svg>

            {/* Large Member Preview - Centered */}
            <div 
                ref={imageRef}
                className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 transition-all duration-500 ease-out ${isVisible ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
                onClick={(e) => e.stopPropagation()} 
            >
                <div className="relative w-64 h-64 md:w-112.5 md:h-112.5 rounded-full border-4 border-green-500 overflow-hidden shadow-[0_0_50px_rgba(34,197,94,0.4)] bg-card group cursor-default">
                     <MemberAvatar member={member} priority={true} />
                     
                     {/* Clean overlay on hover just for shine effect */}
                     <div className="absolute inset-0 bg-linear-to-tr from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                </div>
            </div>

            {/* Info Card - Top Right */}
            <div 
                ref={cardRef}
                className={`absolute top-24 right-5 md:right-10 w-80 md:w-96 z-50 transition-all duration-500 delay-100 ease-out ${isVisible ? 'translate-x-0 opacity-100' : 'translate-x-20 opacity-0'}`}
                onClick={(e) => e.stopPropagation()} 
            >
                <div className="bg-card/90 backdrop-blur-xl border rounded-xl p-5 border-green-500 transition-colors duration-300 relative overflow-visible shadow-[0_0_20px_rgba(34,197,94,0.2)]">
                    {/* Decorative Tech Elements */}
                    <div className="absolute top-0 right-0 p-3 opacity-20 pointer-events-none text-[10px] font-mono text-green-500 text-right leading-tight">
                        {`ID: ${Math.floor(Math.random() * 100).toString().padStart(3, '0')}\nUSR: ${member.nickname ?? member.name.split(' ')[0].toUpperCase()}`}
                    </div>
                
                    <h3 className="text-xl font-bold text-foreground mb-1 mono-font">{member.name}</h3>
                    <div className="text-green-500 text-xs mono-font mb-3 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        {member.role}
                    </div>

                    {member.bio && (
                        <p className="text-muted text-xs leading-relaxed mb-4 line-clamp-3">
                            {member.bio}
                        </p>
                    )}

                    <div className="flex gap-3 pt-3 border-t border-border">
                        {member.github && (
                            <a href={member.github} target="_blank" rel="noreferrer" className="text-muted hover:text-foreground transition-colors text-xs mono-font flex items-center gap-1.5">
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                                GH
                            </a>
                        )}
                        {member.linkedin && (
                            <a href={member.linkedin} target="_blank" rel="noreferrer" className="text-muted hover:text-foreground transition-colors text-xs mono-font flex items-center gap-1.5">
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                                LI
                            </a>
                        )}
                    </div>
                </div>
            </div>


        </div>
    );
}
