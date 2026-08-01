'use strict';

const crypto = require('crypto');

/**
 * Real cross-machine backend for the Channel interface (src/core/Channel.js),
 * using one shared Google Sheet as the rendezvous point: a `presence` tab
 * (instanceId, displayName, lastSeen, toolsJson, photoLink) and a
 * `messages` tab (seq, id, from, to, type, payloadJson, sentAt).
 *
 * This is polling-based — "robust" here means at-least-once delivery via
 * the seq cursor and atomic per-row appends, not low-latency push, and it
 * is not built for high concurrent write throughput (each send() does an
 * append + a follow-up update to safely assign seq from the row the
 * append actually landed on, avoiding a race if two peers send at once —
 * that's two API calls per message). If low-latency push or high message
 * volume is ever needed, put a different backend (Firestore, Cloud
 * Pub/Sub) behind this exact same interface; nothing above this file
 * would need to change.
 *
 * NOT WIRED TO LIVE CREDENTIALS. Requires a service account scoped ONLY
 * to this one spreadsheet (share the sheet with the service account's
 * email as Editor) — never a domain-wide-delegation credential, since
 * this is a shared low-sensitivity resource, not personal user data.
 * Provisioning the actual Google Cloud project / service account /
 * spreadsheet is a separate, explicitly-confirmed step, since it creates
 * real infrastructure under the school's Google org — this class only
 * consumes an already-authenticated `sheetsClient` (a `googleapis`
 * sheets v4 client) and a `spreadsheetId`; it never creates either.
 */
class GoogleSheetsChannel {
  constructor({
    spreadsheetId,
    sheetsClient,
    presenceRange = 'presence!A:E',
    messagesRange = 'messages!A:G',
  }) {
    if (!spreadsheetId) throw new Error('GoogleSheetsChannel requires spreadsheetId');
    if (!sheetsClient) throw new Error('GoogleSheetsChannel requires an authenticated sheetsClient');
    this.spreadsheetId = spreadsheetId;
    this.sheets = sheetsClient;
    this.presenceRange = presenceRange;
    this.messagesRange = messagesRange;
  }

  async _getValues(range) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    return res.data.values ?? [];
  }

  async announce({ instanceId, displayName, photoLink, tools = [] }) {
    const rows = await this._getValues(this.presenceRange);
    const nowIso = new Date().toISOString();
    const toolsJson = JSON.stringify(tools);
    const idx = rows.findIndex((r) => r[0] === instanceId);
    const sheetName = this.presenceRange.split('!')[0];

    if (idx === -1) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: this.presenceRange,
        valueInputOption: 'RAW',
        requestBody: { values: [[instanceId, displayName, nowIso, toolsJson, photoLink ?? '']] },
      });
    } else {
      const rowNumber = idx + 1;
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A${rowNumber}:E${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[instanceId, displayName, nowIso, toolsJson, photoLink ?? '']] },
      });
    }
  }

  async list({ staleAfterMs = 2 * 60 * 1000 } = {}) {
    const rows = await this._getValues(this.presenceRange);
    const now = Date.now();
    return rows
      .map(([instanceId, displayName, lastSeen, toolsJson, photoLink]) => {
        let tools = [];
        try {
          tools = toolsJson ? JSON.parse(toolsJson) : [];
        } catch {
          tools = [];
        }
        return { instanceId, displayName, lastSeen, tools, photoLink: photoLink || undefined };
      })
      .filter((p) => p.lastSeen && now - Date.parse(p.lastSeen) <= staleAfterMs);
  }

  async send({ from, to, type = 'message', payload }) {
    const id = crypto.randomUUID();
    const sentAt = new Date().toISOString();
    const sheetName = this.messagesRange.split('!')[0];

    // seq left blank on first write; backfilled from the row the append
    // actually landed on, so concurrent senders never collide on seq.
    const appendRes = await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.messagesRange,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[null, id, from, to, type, JSON.stringify(payload), sentAt]] },
    });

    const updatedRange = appendRes.data.updates.updatedRange;
    const rowNumber = Number(updatedRange.match(/!\w+(\d+):/)[1]);
    const seq = rowNumber;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[seq]] },
    });

    return { id, seq };
  }

  async receive({ instanceId, sinceSeq = 0 }) {
    const rows = await this._getValues(this.messagesRange);
    return rows
      .filter((r) => Number(r[0]) > sinceSeq)
      .map(([seq, id, from, to, type, payloadJson, sentAt]) => ({
        seq: Number(seq),
        id,
        from,
        to,
        type,
        payload: JSON.parse(payloadJson),
        sentAt,
      }))
      .filter((m) => (m.to === instanceId || m.to === 'broadcast') && m.from !== instanceId);
  }
}

module.exports = { GoogleSheetsChannel };
