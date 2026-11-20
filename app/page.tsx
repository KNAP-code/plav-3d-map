"use client";
import dynamic from "next/dynamic";

const Viewer = dynamic(() => import("@/ui/Viewer"), { ssr: false });

export default function Page() {
  return <Viewer />;
}
