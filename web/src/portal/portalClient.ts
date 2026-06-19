/**
 * Customer-portal API client — deliberately SEPARATE from the staff client.
 *
 * It stores its token under a different localStorage key and never reads the
 * staff token, so the two sessions can never be confused. The portal token is
 * an aud:'customer' JWT that the backend refuses to honour on staff endpoints.
 */
const PORTAL_TOKEN_KEY = 'websol.portal.token';

export function getPortalToken(): string | null {
  return localStorage.getItem(PORTAL_TOKEN_KEY);
}
export function setPortalToken(token: string): void {
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
}
export function clearPortalToken(): void {
  localStorage.removeItem(PORTAL_TOKEN_KEY);
}

export class PortalApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getPortalToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = data?.error?.message ?? `Request failed (${res.status})`;
    throw new PortalApiError(res.status, message, data?.error?.code);
  }
  return data as T;
}

export const portalApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

// --- Portal response shapes ---------------------------------------------------

export interface PortalCustomer {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface PortalContract {
  id: number;
  contractNo: string;
  startDate: string;
  endDate: string;
  monthlyLeaseFee: string;
  slaTier: string;
  status: string;
}

export interface PortalPrinter {
  id: number;
  serialNo: string;
  assetNo: string | null;
  brand: string;
  model: string;
  status: string;
  location: string | null;
  contractNo: string;
}

export interface PortalTicket {
  id: number;
  ticketNo: string;
  visitType: string;
  priority: string;
  status: string;
  description: string | null;
  scheduledDate: string | null;
  slaDueAt: string | null;
  createdAt: string;
}
