import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';

const absolute = z.string().min(1).max(4096).refine(path => isAbsolute(path) && resolve(path) === path && path !== '/');
const https = z.url({ protocol: /^https$/ });
const strings = z.array(z.string().min(1).max(256)).max(100);
export const events = ['completed','completedErrors','transferFailed','connected','disconnected','interrupted','stalled','lowBattery','cameraSpace','nasSpace','destination','cameraError','applicationError'] as const;
export const preferences = z.partialRecord(z.enum(events), z.boolean());
const media = z.array(z.enum(['jpg','jpeg','cr3','hif','heif','heic','mp4','mov'])).min(1).max(8);
const layout = z.enum(['flat','date','camera','camera-date']);
const timeZone = z.string().trim().min(1).max(128).refine(value=>{
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; }
  catch { return false; }
},'Enter a named time zone such as America/Los_Angeles');
export const settingsSchema = z.object({
  destination: absolute, layout: layout.default('flat'), media: media.default(['jpg','jpeg','cr3','hif','heif','heic','mp4','mov']),
  concurrency: z.number().int().min(1).max(8).default(2),
  poll: z.number().int().min(15).max(86400).default(90),
  retries: z.number().int().min(0).max(12).default(4),
  minimumBytes: z.number().int().nonnegative().default(1024 ** 3),
  thumbnailBytes: z.number().int().min(0).max(2 ** 31).default(250 * 1024 ** 2),
  batchSeconds: z.number().int().min(0).max(3600).default(15),
  eventDays: z.number().int().min(1).max(365).default(30),
  batteryThreshold: z.number().int().min(1).max(100).default(20),
  cameraMinimumBytes: z.number().int().nonnegative().default(1024 ** 3),
  appearance: z.enum(['system','light','dark']).default('system'),
  paused: z.boolean().default(false), notifications: preferences.default({}),
  privatePush: z.boolean().default(true)
}).strict();
export const cameraSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true), paused: z.boolean().default(false),
  address: z.url().refine(value => {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && url.pathname === '/' &&
      !url.username && !url.password && !url.search && !url.hash;
  }),
  serial: z.string().trim().min(1).max(128),
  secretRef: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  destination: absolute.optional(), layout: layout.optional(), media: media.optional(),
  cardRecording: z.enum(['all','duplicate-stills']).optional(),
  timeZone: timeZone.optional(),
  poll: z.number().int().min(15).max(86400).optional(),
  concurrency: z.number().int().min(1).max(4).default(1),
  priority: z.number().int().min(0).max(10).default(5),
  mode: z.enum(['all','new']).default('all'), notifications: preferences.default({})
}).strict();
export const bootstrapSchema = z.object({
  origin: https.refine(value => new URL(value).origin === value),
  port: z.number().int().min(1024).max(65535).default(8787),
  data: absolute, allowedRoots: z.array(absolute).min(1),
  ccapiModule: absolute.optional(),
  cameraNetworks: strings,
  pushSubject: z.string().regex(/^(mailto:|https:\/\/)/),
  oidc: z.object({
    issuer: https, discovery: https.optional(), clientId: z.string().min(1),
    subjects: strings.default([]), groups: strings.default([]),
    groupsClaim: z.string().default('groups'), postLogout: https.optional(),
    clientAuth: z.enum(['client_secret_post','client_secret_basic']).default('client_secret_post'),
    pkce: z.boolean().default(true), sessionMinutes: z.number().int().min(5).max(1440).default(480)
  }).strict(),
  settings: settingsSchema
}).strict();
export const secretSchema = z.object({
  oidcClientSecret: z.string().min(1),
  cameras: z.record(z.string(), z.object({
    ca: z.string().optional(), authorization: z.string().optional(),
    digest: z.object({
      username:z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/),
      password:z.string().min(1).max(256)
    }).strict().optional()
  }).strict().refine(profile=>!(profile.digest && profile.authorization),'Choose either Digest or a static Authorization header')).default({})
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export type CameraConfig = z.infer<typeof cameraSchema> & { id: string; created: number };
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type Secrets = z.infer<typeof secretSchema>;
export type EventKind = typeof events[number];
