export type JsonObject = Record<string, unknown>;

export type VapiToolCall = {
  id?: string;
  toolCallId?: string;
  function?: { name?: string; arguments?: string | JsonObject };
  name?: string;
  arguments?: string | JsonObject;
};

export type VapiMessage = {
  type?: string;
  call?: JsonObject;
  toolCallList?: VapiToolCall[];
  artifact?: JsonObject;
  [key: string]: unknown;
};

export type EventRecord = {
  eventId: string;
  type: string;
  status: "processing" | "completed" | "failed";
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  correlationId: string;
  encryptedPayload: { iv: string; tag: string; data: string };
  lastError?: string;
};

export type CallSummary = {
  callerName: string | null;
  phone: string | null;
  email: string | null;
  serviceRequested: string | null;
  propertyAddress: string | null;
  urgency: "emergency" | "urgent" | "routine" | "unknown";
  appointmentRequested: boolean;
  appointmentAt: string | null;
  qualified: boolean;
  summary: string;
  nextAction: string;
};
