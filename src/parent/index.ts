// @ts-ignore
import socks5 from 'node-socks5-server';

function startProxyServer(port: number) {
  console.log("starting proxy on", port);
  const server = socks5.createServer();
  server.listen(port);
}

export function mainParent(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const port = Number(argv?.[1]) || 1080;
    startProxyServer(port);
  }
}
