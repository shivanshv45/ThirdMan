"use client";

import { useEffect, useRef } from "react";

export function BackgroundVideo({ srcWebm, srcMp4, playbackRate = 0.75 }: { srcWebm: string, srcMp4: string, playbackRate?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

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
