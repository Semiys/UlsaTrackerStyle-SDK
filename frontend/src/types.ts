export type User = { id: string; name: string; email: string };
export type Session = { user: User | null; csrfToken: string; endpoint: string; version: string; demoMode: boolean; grafanaAvailable: boolean; labImageVersion?: string };
export type Project = { id: string; name: string; archived: boolean; applications?: number };
export type Application = { id: string; name: string; platform: 'android' | 'web' | 'ios'; identifier: string; project_id: string; project_name: string; archived: boolean; deleting: boolean };
export type SendingKey = { id: string; display: string; revoked_at: number | null };
export type ApplicationData = { application: Application; keys: SendingKey[]; rawKey?: string };
export type Selection = { kind: 'relative'; id: string } | { kind: 'absolute'; from: number; to: number };
