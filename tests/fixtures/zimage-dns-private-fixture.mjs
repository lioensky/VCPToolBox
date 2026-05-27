import dns from 'dns/promises';

const originalLookup = dns.lookup.bind(dns);
const privateHost = (process.env.ZIMAGE_TEST_DNS_PRIVATE_HOST || 'image-private.test').toLowerCase();

dns.lookup = async function lookup(hostname, options) {
  if (String(hostname || '').toLowerCase() === privateHost) {
    const record = { address: '127.0.0.1', family: 4 };
    return options && options.all ? [record] : record;
  }

  return originalLookup(hostname, options);
};
