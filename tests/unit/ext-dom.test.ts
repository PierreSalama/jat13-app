// @vitest-environment jsdom
//
// The thin extension's sensor+actuator, exercised against a real (jsdom) DOM. Asserts the §3.3 sensor
// rules that encode v11 scars — role/name mapping, hidden-input grounding (v11.56), group-prompt
// resolution (v11.66), value redaction — and that the actuator's fill/click actually mutate the DOM
// and fire the events React controlled inputs need. jsdom lacks some browser APIs; we polyfill the
// few the code guards for (crypto.randomUUID, Element.scrollIntoView) so nothing throws.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSnapshot, getElementByNid } from '../../extension/src/sensor.js';
import { execute } from '../../extension/src/actuator.js';
import type { SnapNode, Cmd } from '@jat13/shared/protocol';

// ---- jsdom polyfills the sensor/actuator defensively guard for -------------
beforeEach(() => {
  if (!(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')) {
    // @ts-expect-error test shim
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'ep_test_uuid' };
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }
});

function setBody(html: string): void {
  document.body.innerHTML = html;
}

const find = (nodes: SnapNode[], pred: (n: SnapNode) => boolean): SnapNode | undefined => nodes.find(pred);

describe('sensor — buildSnapshot (§3.3 rules)', () => {
  it('maps a labelled email input to role=textbox with the label as the accessible name', () => {
    setBody(`
      <form>
        <label for="em">Email address</label>
        <input id="em" type="email" name="email" value="pierre@x.io" />
      </form>
    `);
    const snap = buildSnapshot(document, 'ep_1');
    const nodes = snap.frames[0]!.nodes;
    const email = find(nodes, (n) => n.role === 'textbox');
    expect(email).toBeDefined();
    expect(email!.name).toBe('Email address');
    expect(email!.value).toBe('pierre@x.io');
    expect(snap.hash).toMatch(/^sha1_/);
    expect(snap.v).toBe(1);
    expect(snap.epoch).toBe('ep_1');
  });

  it('grounds a hidden (opacity:0) radio group via its visible label + label rect (v11.56)', () => {
    setBody(`
      <fieldset>
        <legend>Are you legally authorized to work in Canada?</legend>
        <label for="wa_yes">Yes</label>
        <input id="wa_yes" type="radio" name="work_auth" value="yes" style="opacity:0" />
        <label for="wa_no">No</label>
        <input id="wa_no" type="radio" name="work_auth" value="no" style="opacity:0" />
      </fieldset>
    `);
    const snap = buildSnapshot(document, 'ep_hidden');
    const radios = snap.frames[0]!.nodes.filter((n) => n.role === 'radio');
    expect(radios.length).toBe(2);
    // hidden-input grounding: included WITH states.hiddenInput
    expect(radios.every((r) => r.states?.hiddenInput === true)).toBe(true);
    // the two radios share ONE group id
    expect(radios[0]!.group).toBeDefined();
    expect(radios[0]!.group).toBe(radios[1]!.group);
    // group prompt resolves from the fieldset legend, not a machine id
    expect(radios[0]!.groupPrompt).toBe('Are you legally authorized to work in Canada?');
    // the affordance names come from the visible labels
    expect(radios.map((r) => r.name).sort()).toEqual(['No', 'Yes']);
  });

  it('emits groupPrompt="" when the resolver only finds a machine id (v11.66 no-dirty-label law)', () => {
    setBody(`
      <div role="radiogroup" aria-labelledby="q_af31">
        <span id="q_af31">q_af31</span>
        <label for="r1">Option A</label>
        <input id="r1" type="radio" name="q_af31" style="opacity:0" />
      </div>
    `);
    const snap = buildSnapshot(document, 'ep_machine');
    const radio = snap.frames[0]!.nodes.find((n) => n.role === 'radio');
    expect(radio).toBeDefined();
    expect(radio!.groupPrompt).toBe('');
  });

  it('reports a disabled Continue button as present with states.disabled (never absent)', () => {
    setBody(`<form><button type="submit" disabled>Continue</button></form>`);
    const snap = buildSnapshot(document, 'ep_dis');
    const btn = snap.frames[0]!.nodes.find((n) => n.role === 'button');
    expect(btn).toBeDefined();
    expect(btn!.name).toBe('Continue');
    expect(btn!.states?.disabled).toBe(true);
  });

  it('flags a leading loading token with loadingLabel but keeps the RAW name (v11.86)', () => {
    setBody(`<form><button type="submit">Loading…Submit application</button></form>`);
    const snap = buildSnapshot(document, 'ep_load');
    const btn = snap.frames[0]!.nodes.find((n) => n.role === 'button');
    expect(btn!.states?.loadingLabel).toBe(true);
    expect(btn!.name).toBe('Loading…Submit application'); // stripping is app-side, not here
  });

  it('redacts the value of a password field and a sensitive-named field (§3.3 rule 5)', () => {
    setBody(`
      <form>
        <label for="pw">Password</label>
        <input id="pw" type="password" name="password" value="hunter2" />
        <label for="ssn">Social Security Number</label>
        <input id="ssn" type="text" name="ssn" value="123-45-6789" />
      </form>
    `);
    const nodes = buildSnapshot(document, 'ep_secret').frames[0]!.nodes;
    const pw = nodes.find((n) => n.attrs?.type === 'password');
    const ssn = nodes.find((n) => /social security/i.test(n.name));
    expect(pw!.value).toBeUndefined();
    expect(ssn!.value).toBeUndefined();
  });

  it('redacts a sensitive <select> value (EEO gender/veteran dropdowns are often selects)', () => {
    setBody(`
      <form>
        <label for="gen">Gender</label>
        <select id="gen" name="gender"><option value="f" selected>Female</option><option value="m">Male</option></select>
        <label for="cty">Country</label>
        <select id="cty" name="country"><option value="ca" selected>Canada</option></select>
      </form>
    `);
    const nodes = buildSnapshot(document, 'ep_sel').frames[0]!.nodes;
    const gender = nodes.find((n) => /gender/i.test(n.name))!;
    const country = nodes.find((n) => /country/i.test(n.name))!;
    expect(gender.value).toBeUndefined();       // sensitive select redacted
    expect(country.value).toBe('ca');            // benign select value still reported
  });

  it('getElementByNid resolves a snapshot node back to its live element (same epoch)', () => {
    setBody(`<form><label for="em2">Email</label><input id="em2" type="email" /></form>`);
    const snap = buildSnapshot(document, 'ep_nid');
    const email = snap.frames[0]!.nodes.find((n) => n.role === 'textbox')!;
    const el = getElementByNid(email.nid);
    expect(el).toBe(document.getElementById('em2'));
  });
});

describe('actuator — execute (§3.5)', () => {
  it('fill sets the input value AND dispatches input + change, then returns a fresh snapshotDelta', async () => {
    setBody(`<form><label for="em3">Email</label><input id="em3" type="email" name="email" /></form>`);
    const snap = buildSnapshot(document, 'ep_fill');
    const email = snap.frames[0]!.nodes.find((n) => n.role === 'textbox')!;
    const input = document.getElementById('em3') as HTMLInputElement;

    let inputFired = false;
    let changeFired = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });

    const cmd: Cmd = { op: 'fill', target: { nid: email.nid, rebindPath: email.path }, value: 'me@here.io', method: 'auto' };
    const res = await execute(cmd, { doc: document, epoch: 'ep_fill' });

    expect(res.ok).toBe(true);
    expect(input.value).toBe('me@here.io');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
    expect(res.snapshotDelta).toBeDefined();
    expect(res.snapshotDelta!.epoch).toBe('ep_fill');
    // the delta reflects the new value
    const after = res.snapshotDelta!.frames[0]!.nodes.find((n) => n.role === 'textbox');
    expect(after!.value).toBe('me@here.io');
  });

  it('click fires a real click on the targeted button', async () => {
    setBody(`<form><button id="go" type="button">Continue</button></form>`);
    const snap = buildSnapshot(document, 'ep_click');
    const btn = snap.frames[0]!.nodes.find((n) => n.role === 'button')!;
    let clicked = false;
    (document.getElementById('go') as HTMLButtonElement).addEventListener('click', () => { clicked = true; });

    const res = await execute({ op: 'click', target: { nid: btn.nid } }, { doc: document, epoch: 'ep_click' });
    expect(res.ok).toBe(true);
    expect(clicked).toBe(true);
    expect(res.snapshotDelta).toBeDefined();
  });

  it('click on a disabled control returns error=disabled and never fires', async () => {
    setBody(`<form><button id="d" type="submit" disabled>Continue</button></form>`);
    const snap = buildSnapshot(document, 'ep_disc');
    const btn = snap.frames[0]!.nodes.find((n) => n.role === 'button')!;
    let clicked = false;
    (document.getElementById('d') as HTMLButtonElement).addEventListener('click', () => { clicked = true; });
    const res = await execute({ op: 'click', target: { nid: btn.nid } }, { doc: document, epoch: 'ep_disc' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('disabled');
    expect(clicked).toBe(false);
  });

  it('a command targeting an unknown nid reports not_found (honest, never a crash)', async () => {
    setBody(`<form><input id="x" type="text" /></form>`);
    buildSnapshot(document, 'ep_nf');
    const res = await execute({ op: 'fill', target: { nid: 999999 }, value: 'y', method: 'auto' }, { doc: document, epoch: 'ep_nf' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
  });

  it('chooseRadio scopes to the TARGET group when two groups share a "Yes"/"No" label', async () => {
    // Two independent yes/no questions on one page. A document-wide scan would pick the FIRST "Yes"
    // (the wrong group); chooseRadio must honor cmd.group and select within the addressed group only.
    setBody(`
      <form>
        <fieldset name="fs1">
          <legend>Authorized to work?</legend>
          <label for="a_yes">Yes</label><input id="a_yes" type="radio" name="auth" value="y" />
          <label for="a_no">No</label><input id="a_no" type="radio" name="auth" value="n" />
        </fieldset>
        <fieldset name="fs2">
          <legend>Require sponsorship?</legend>
          <label for="s_yes">Yes</label><input id="s_yes" type="radio" name="spon" value="y" />
          <label for="s_no">No</label><input id="s_no" type="radio" name="spon" value="n" />
        </fieldset>
      </form>
    `);
    const snap = buildSnapshot(document, 'ep_grp');
    const radios = snap.frames[0]!.nodes.filter((n) => n.role === 'radio');
    // resolve the two groups' ids directly from the DOM to be unambiguous
    const sponGroup = radios.find((r) => getElementByNid(r.nid) === document.getElementById('s_yes'))!.group!;
    const authGroup = radios.find((r) => getElementByNid(r.nid) === document.getElementById('a_yes'))!.group!;
    expect(sponGroup).not.toBe(authGroup);

    const res = await execute({ op: 'chooseRadio', group: sponGroup, option: { byText: 'Yes' } }, { doc: document, epoch: 'ep_grp' });
    expect(res.ok).toBe(true);
    // ONLY the sponsorship "Yes" is checked; the auth group (whose "Yes" comes FIRST in document order,
    // the one a naive document-wide scan would wrongly pick) is untouched.
    expect((document.getElementById('s_yes') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('a_yes') as HTMLInputElement).checked).toBe(false);
  });
});
