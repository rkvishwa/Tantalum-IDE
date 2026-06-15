"use client";

import Image from "next/image";
import { useState } from "react";
import { Member } from "@/data/members";

interface MemberAvatarProps {
    member: Member;
    priority?: boolean;
}

export default function MemberAvatar({ member, priority = false }: MemberAvatarProps) {
    // Priority: Local Image (using GitHub username) -> GitHub Avatar -> Initials
    const getSlug = () => {
        if (member.github) {
            const parts = member.github.split('/').filter(Boolean);
            return parts[parts.length - 1];
        }
        return member.name.toLowerCase().replace(/\s+/g, '-');
    };

    const slug = getSlug();
    const localImage = `/team/${slug}.png`;
    
    // State to track current image source and loading status
    const [imgSrc, setImgSrc] = useState(localImage);
    const [hasError, setHasError] = useState(false);

    const handleError = () => {
        if (imgSrc === localImage && member.image) {
            // If local image fails, try member.image (GitHub)
            setImgSrc(member.image);
        } else {
            // If both fail, show fallback
            setHasError(true);
        }
    };

    if (hasError) {
        return (
            <div className="w-full h-full flex items-center justify-center text-muted font-bold text-lg bg-card">
                {member.name.substring(0, 2).toUpperCase()}
            </div>
        );
    }

    return (
        <Image
            src={imgSrc}
            alt={member.name}
            fill
            className="object-cover transition-opacity duration-300"
            onError={handleError}
            priority={priority}
        />
    );
}
