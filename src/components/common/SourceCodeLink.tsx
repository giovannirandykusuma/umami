const repositoryUrl = 'https://github.com/giovannirandykusuma/umami';

export function getSourceCodeUrl(configuredUrl = process.env.NEXT_PUBLIC_SOURCE_URL) {
  // next.config.ts validates and binds this public value before production builds.
  // Development alone may use the unversioned repository.
  return configuredUrl || repositoryUrl;
}

export function SourceCodeLink() {
  return (
    <a
      href={getSourceCodeUrl()}
      style={{ padding: '8px 12px', textDecoration: 'underline', whiteSpace: 'nowrap' }}
    >
      {process.env.NEXT_PUBLIC_SOURCE_URL ? 'Source code' : 'Source code (development)'}
    </a>
  );
}
