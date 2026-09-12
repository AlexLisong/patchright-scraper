import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { ApiError } from './errors.mjs';

export function isPublicAddress(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv6') return ip.match(ipaddr.parse('2000::'), 3);
    // Azure's host virtual IP is not a public Internet destination.
    return ip.toString() !== '168.63.129.16';
  } catch { return false; }
}

export function targetUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new ApiError('INVALID_REQUEST', 'A valid absolute URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ApiError('TARGET_BLOCKED', 'Only HTTP(S) URLs without credentials are allowed.', 403);
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new ApiError('TARGET_BLOCKED', 'Only ports 80 and 443 are allowed.', 403);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.includes('%') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new ApiError('TARGET_BLOCKED', 'Local addresses are not allowed.', 403);
  }
  return url;
}

export async function resolvePublic(host, resolver = lookup) {
  host = host.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolver(host, { all: true, verbatim: true }); }
  catch { throw new ApiError('UPSTREAM_ERROR', 'Target DNS lookup failed.', 502); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ApiError('TARGET_BLOCKED', 'Private, local, or reserved network destinations are blocked.', 403);
  }
  return addresses.find(a => a.family === 4) || addresses[0];
}

// DNS is validated once and the socket connects to that literal address, preventing
// a second DNS lookup (and rebinding) between validation and connection.
export async function createEgress({ resolve = resolvePublic, connect = net.connect, validate = targetUrl } = {}) {
  const sockets = new Set();
  let closing = false;
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(60000, () => socket.destroy());
    if (closing) socket.destroy();
    return socket;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = validate(req.url);
      const address = await resolve(url.hostname);
      if (closing || req.destroyed) return res.destroy();
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request({
        hostname: address.address, family: address.family, port: url.port || 80,
        method: req.method, path: `${url.pathname}${url.search}`, headers,
        agent: false, timeout: 30000,
      }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) { res.writeHead(error.statusCode || 502); res.end('Outbound destination rejected'); }
  });
  server.on('connect', async (req, client, head) => {
    try {
      const url = validate(`https://${req.url}`);
      const address = await resolve(url.hostname);
      if (closing || client.destroyed) return client.destroy();
      const upstream = track(connect({ host: address.address, family: address.family, port: Number(url.port || 443) }));
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}
