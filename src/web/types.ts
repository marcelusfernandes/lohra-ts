export interface AddressRecord {
  readonly address: string;
  readonly family: 4 | 6;
}

export type Resolver = (
  host: string,
  port: number | null,
) => readonly AddressRecord[] | Promise<readonly AddressRecord[]>;

export interface ValidatedUrl {
  readonly scheme: string;
  readonly hostname: string;
  readonly port: number | null;
  readonly addresses: readonly AddressRecord[];
  readonly url: URL;
}

export interface FetchLimits {
  readonly timeoutSeconds: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
}

export const FETCH_LIMITS: FetchLimits = {
  timeoutSeconds: 10,
  maxBytes: 2_000_000,
  maxRedirects: 4,
  userAgent: "lohra-web/0.1 (+https://github.com/lohra)",
};

export interface ConnectorRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly allowedAddresses: readonly AddressRecord[];
  readonly hostname: string;
  readonly timeoutSeconds: number;
  readonly deadlineMs: number;
}

export interface ConnectorStream {
  next(): Promise<IteratorResult<Uint8Array>>;
  cancel(): Promise<void>;
}

export interface ConnectorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly peer: string | null;
  readonly stream: ConnectorStream;
}

export interface HttpConnector {
  request(request: ConnectorRequest): Promise<ConnectorResponse>;
}

export interface SearchEnvelopeResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchBackend {
  search(query: string, maxResults: number): Promise<readonly SearchEnvelopeResult[]>;
}

export interface WebTransport {
  readonly resolver: Resolver;
  readonly connector: HttpConnector;
}

export interface FetchStats {
  readonly bufferedBytes: number;
  readonly cancelled: boolean;
  readonly readCalls: number;
}
