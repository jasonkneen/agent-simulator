import { useEffect, useMemo, useRef, useState } from "react";
import { SimSocket, type ServerMsg } from "@/lib/ws";

export function useSimSocket(url: string) {
  const [open, setOpen] = useState(false);
  const socketRef = useRef<SimSocket | null>(null);

  const socket = useMemo(() => {
    const s = new SimSocket(url);
    socketRef.current = s;
    return s;
  }, [url]);

  useEffect(() => {
    const off = socket.onOpen(setOpen);
    return () => {
      off();
      socket.close();
    };
  }, [socket]);

  return { socket, open };
}

export function useSubscribe(
  socket: SimSocket | null,
  handler: (msg: ServerMsg) => void
) {
  useEffect(() => {
    if (!socket) return;
    const off = socket.on(handler);
    return () => {
      off();
    };
  }, [socket, handler]);
}
