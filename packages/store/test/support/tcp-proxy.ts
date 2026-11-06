import net from 'node:net';

/**
 * 대상 DB 앞에 두는 TCP 프록시. `freeze()`하면 새 연결은 받기만 하고 업스트림에 잇지 않으며,
 * 이미 이어진 연결은 데이터를 버린다. "응답하지 않는 대상 DB"를 흉내 내는 데 쓴다.
 */
export interface TcpProxy {
  readonly host: string;
  readonly port: number;
  freeze(): void;
  thaw(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(upstreamHost: string, upstreamPort: number): Promise<TcpProxy> {
  let frozen = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    if (frozen) return; // 받기만 하고 아무것도 보내지 않는다

    const upstream = net.connect(upstreamPort, upstreamHost);
    sockets.add(upstream);
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.on('data', (chunk: Buffer) => {
      if (!frozen) upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!frozen) client.write(chunk);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    freeze: () => (frozen = true),
    thaw: () => (frozen = false),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
