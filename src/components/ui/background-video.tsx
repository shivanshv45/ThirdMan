"use client";

import { useEffect, useRef } from "react";

export function BackgroundVideo({ srcWebm, srcMp4 }: { srcWebm: string, srcMp4: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = 0.75;
    }
  }, []);

  return (
    <video 
      ref={videoRef}
      autoPlay 
      loop 
      muted 
      playsInline 
      className="absolute inset-0 w-full h-full object-cover -z-10 opacity-70 pointer-events-none"
    >
      <source src={srcWebm} type="video/webm" />
      <source src={srcMp4} type="video/mp4" />
    </video>
  );
}
