export function supportsRasterConnections(metrics) {
  const policy = metrics?.connectionPolicy;
  return metrics?.disconnectAccountingSupported === true && policy?.version >= 1 &&
    policy.httpProtocol === 'HTTP/1.1' && policy.requestQueueSize >= 128;
}
