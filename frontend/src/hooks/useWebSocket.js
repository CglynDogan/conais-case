import { useEffect, useRef, useState, useCallback } from 'react';
import { WS_URL, WS_EVENTS, RECONNECT_DELAY_MS, MAX_RECONNECT_ATTEMPTS } from '../constants';

export function useWebSocket(onMessage) {
  const [status, setStatus] = useState('disconnected'); // 'connecting' | 'connected' | 'disconnected' | 'error'
  const wsRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setStatus('connected');
      reconnectAttempts.current = 0;
      ws.send(JSON.stringify({ type: WS_EVENTS.CLIENT_PING, payload: {} }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessageRef.current?.(msg);
      } catch {
        console.warn('[WS] Failed to parse message', event.data);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WS] Max reconnect attempts reached');
      return;
    }
    reconnectAttempts.current += 1;
    reconnectTimer.current = setTimeout(() => {
      console.log(`[WS] Reconnecting… attempt ${reconnectAttempts.current}`);
      connect();
    }, RECONNECT_DELAY_MS);
  }, [connect]);

  const send = useCallback((type, payload = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('[WS] Cannot send — not connected');
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, send };
}
