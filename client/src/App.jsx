import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, AreaChart, Area } from "recharts";

const TEAL = "#4A7C6B";
const TEAL_DARK = "#2D4A3E";
const TEAL_LIGHT = "#EBF2EF";
const ORANGE = "#C8952A";

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Leesfout"));
    r.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Leesfout"));
    r.readAsDataURL(file);
  });
}

/** Downscale large photos before sending to API — faster uploads + faster model inference. */
async function compressImageForApi(file, maxDim = 1600, quality = 0.82) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const img = await createImageBitmap(file);
    let w = img.width;
    let h = img.height;
    if (w <= maxDim && h <= maxDim) {
      img.close?.();
      return file;
    }
    if (w >= h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      img.close?.();
      return file;
    }
    ctx.drawImage(img, 0, 0, w, h);
    img.close?.();
    const blob = await new Promise((res, rej) => {
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", quality);
    });
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function parseJsonSafe(response) {
  const raw = await response.text();
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, raw };
  }
}

/** Parse "€4.500" / "€4.500,00" style bedrag to integer euros (monthly scenario). */
function parseMonthlyEuroFromBedrag(bedragStr) {
  if (!bedragStr || typeof bedragStr !== "string") return null;
  const cleaned = bedragStr.replace(/€/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function formatEURInt(n) {
  return "€" + Math.round(n).toLocaleString("nl-BE");
}

/** Splits bedrag incl. 21% btw naar excl. + btw (afgerond per component). */
function splitIncl21(incl) {
  const n = Math.max(0, Math.round(Number(incl)) || 0);
  const excl = Math.round(n / 1.21);
  const btw = n - excl;
  return { incl: n, excl, btw };
}

/** Parseer "4", "8+", etc. naar een geheel getal (0 bij ontbreken). */
function parseCapacityInt(s) {
  const n = parseInt(String(s ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Herkenning: oude pakket-matrix (Starter/Standard/… × scenario-kolommen) of netto-YourDomi-fee tabel. */
function isLegacyFeeScenarioTable(plainText) {
  const t = plainText.replace(/\s+/g, " ");
  const scen =
    /conservatief/i.test(t) && /realistisch/i.test(t) && /optimaal/i.test(t);
  if (!scen) return false;
  if (/starter/i.test(t) && (/standard|premium|full\s*service/i.test(t) || /\b10\s*%/.test(t))) return true;
  if (/pakket/i.test(t) && /\b10\s*%/.test(t) && /\b20\s*%/.test(t)) return true;
  if (/netto[-\s]*inkomsten/i.test(t) && /yourdomi/i.test(t)) return true;
  return false;
}

/**
 * Verwijdert oude AI-output: matrix "netto na fee" met Starter/Standard/Premium/Full Service
 * (10/20/25/30%) × Conservatief/Realistisch/Optimaal. Die hoort niet in het rapport (app toont dit).
 */
function stripLegacyPackageNettoTables(html) {
  if (!html || typeof html !== "string") return html;
  let out = html;
  out = out.replace(
    /<h[23][^>]*>[^<]*(?:NETTO[-\s]*INKOMSTEN|netto[-\s]*inkomsten)[^<]*(?:YOURDOMI|yourdomi)[^<]*<\/h[23]>\s*(?:<p[^>]*>[^<]*<\/p>\s*)?<table[\s\S]*?<\/table>/gi,
    ""
  );
  out = out.replace(
    /<p[^>]*>\s*(?:<strong>)?\s*[^<]*(?:NETTO[-\s]*INKOMSTEN|netto[-\s]*inkomsten)[^<]*(?:YOURDOMI|yourdomi)[^<]*(?:<\/strong>)?\s*<\/p>\s*<table[\s\S]*?<\/table>/gi,
    ""
  );
  let prev;
  do {
    prev = out;
    out = out.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (block) => {
      const textOnly = block.replace(/<[^>]+>/g, " ");
      return isLegacyFeeScenarioTable(textOnly) ? "" : block;
    });
  } while (out !== prev);
  out = out.replace(
    /<p[^>]*>\s*[^<]*Maandelijkse netto-inkomsten[^<]*platform[^<]*<\/p>/gi,
    ""
  );
  return out.replace(/(<\/p>\s*){2,}/gi, "$1").trim();
}

/**
 * Verwijdert legacy-tabellen uit de gerenderde DOM (vangt varianten die regex mist).
 */
function removeLegacyNettoTablesFromDom(root) {
  if (!root) return;
  const tables = Array.from(root.querySelectorAll("table"));
  tables.forEach((table) => {
    const text = table.innerText || table.textContent || "";
    if (!isLegacyFeeScenarioTable(text)) return;
    const foot = table.nextElementSibling;
    if (foot && /Maandelijkse netto-inkomsten/i.test(foot.textContent || "")) foot.remove();
    const head = table.previousElementSibling;
    table.remove();
    if (head && /NETTO/i.test(head.textContent || "")) head.remove();
  });
}

function ReportBodyHtml({ html }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    removeLegacyNettoTablesFromDom(ref.current);
  }, [html]);
  return <div ref={ref} className="report-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function pandTypeLabelNl(type) {
  const m = {
    appartement: "appartement",
    woning: "woning",
    studio: "studio",
    villa: "villa",
    vakantiewoning: "vakantiewoning",
  };
  return m[type] || type || "logies";
}

/**
 * Vaste checklist afgeleid van formulier (adres, type, capaciteit) — onafhankelijk van AI-brandweeritems.
 */
function buildPandBrandveiligheidPunten({ address, gemeente, type, kamers, slaapplaatsen }) {
  const addr = (address || "").trim();
  const gem = (gemeente || "").trim();
  const typeNl = pandTypeLabelNl(type);
  const sp = parseCapacityInt(slaapplaatsen);
  const sk = parseCapacityInt(kamers);
  const lines = [];
  if (addr || gem) {
    lines.push(
      `Dit onderdeel sluit aan bij uw dossier: **${addr || "—"}**${gem ? ` (${gem})` : ""}, type **${typeNl}**.`
    );
  }
  lines.push(
    `In het formulier staan **${kamers || "—"} slaapkamer(s)** en **${slaapplaatsen || "—"} slaapplaatsen** — gebruik die exacte aantallen bij contact met de brandweerzone (niet raden of overschrijven).`
  );
  if (sp > 8) {
    lines.push(
      `Met **${sp} slaapplaatsen** zit u **boven de veelgebruikte drempel van 8**. Voor dergelijke logies zijn brandweerkeuring en conformiteitsattest doorgaans aangewezen; vraag timing en procedure bij uw zone in ${gem || "uw gemeente"}.`
    );
  } else if (sp > 0) {
    lines.push(
      `Met **${sp} slaapplaatsen** zit u **op of onder de veelgebruikte drempel van 8**; verplichtingen voor een conformiteitsattest vallen daardoor doorgaans lichter uit dan bij grotere logies. **Lokale bevestiging** bij de brandweerzone blijft nodig.`
    );
  } else {
    lines.push(
      "U hebt geen slaapplaatsen ingevuld — vul die in voor een correcte inschatting met de brandweerzone."
    );
  }
  if (sk > 0) {
    lines.push(
      `**Rookmelders:** minstens **${sk}** toestel(len) bij slaapkamers, plus minstens één per **verdieping/bouwlaag** van het gehuurde pand; vul aan waar de plattegrond dat vereist.`
    );
  } else {
    lines.push(
      "**Rookmelders:** minstens één per slaapkamer en per verdieping van het gehuurde pand (aantal slaapkamers invullen in het formulier verfijnt dit verder)."
    );
  }
  lines.push(
    "**CO-melder:** doorgaans vereist als gasten toegang hebben tot vaste brandstoftoestellen (o.a. gas); laat uw installatie bevestigen door een erkende technicus indien nodig."
  );
  if (type === "appartement") {
    lines.push(
      "**Appartement:** check met syndicus/VME over **gemeenschappelijke vluchtroutes**, traphal en eventuele huisregels naast de verplichtingen binnen uw unit."
    );
  } else if (type === "studio") {
    lines.push(
      "**Studio:** slaap- en leefzone vallen vaak samen — zorg voor voldoende rookmelders zodat zowel slaap- als verblijfszone snel gedetecteerd worden."
    );
  } else if (type === "woning" || type === "villa" || type === "vakantiewoning") {
    lines.push(
      `**${typeNl.charAt(0).toUpperCase() + typeNl.slice(1)}:** let op meerdere bouwlagen, bijgebouwen (poolhouse, garage) en open haard/gaskachel waar gasten bij kunnen — uitbreid rook- en CO-bescherming indien nodig.`
    );
  }
  return lines;
}

/** Zet segmenten **vet** in een string om naar JSX-fragmenten (één regel). */
function lineToBoldSpans(line) {
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(<strong key={`b${k++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function tailorBrandweerToInput(items, { slaapplaatsen, kamers, type, gemeente }) {
  if (!items?.length) return items;
  const sp = parseCapacityInt(slaapplaatsen);
  const sk = parseCapacityInt(kamers);
  const typeNl = pandTypeLabelNl(type);
  const zone = (gemeente || "").trim();
  return items.map((item) => {
    const low = (item.titel || "").toLowerCase();
    if (low.includes("conformiteit")) {
      const zoneHint = zone ? ` Brandweerzone ${zone} bevestigt de definitieve lijn.` : "";
      const typeHint =
        type === "appartement"
          ? " In een appartementsgebouw spelen ook gemeenschappelijke vluchtroutes mee."
          : "";
      const tekst =
        sp > 8
          ? `U heeft ${sp} slaapplaatsen ingesteld — dat is meer dan 8. Voor dit ${typeNl} zijn een brandweerkeuring en conformiteitsattest doorgaans aangewezen.${typeHint}${zoneHint}`
          : sp > 0
            ? `U heeft ${sp} slaapplaatsen ingesteld — dat is niet meer dan 8. Voor dit ${typeNl} vallen verplichtingen voor een conformiteitsattest doorgaans lichter uit dan bij grotere logies (>8 slaapplaatsen).${typeHint} Controleer altijd bij uw brandweerzone — lokale interpretatie kan afwijken.`
            : item.tekst ||
              "Controleer bij uw brandweerzone of een conformiteitsattest of keuring voor uw situatie nodig is.";
      return { ...item, tekst };
    }
    if (low.includes("rookmelder") || low.includes("co")) {
      const typeLead = typeNl ? `Pandtype ${typeNl}. ` : "";
      const ctx =
        sk > 0 && sp > 0
          ? `${typeLead}Voor uw pand (${sk} slaapkamer(s), ${sp} slaapplaatsen): `
          : sp > 0
            ? `${typeLead}Voor uw pand (${sp} slaapplaatsen): `
            : typeLead
              ? `${typeLead}`
              : "";
      const rest =
        item.tekst ||
        "Rookmelders zijn verplicht per slaapkamer en op elke verdieping. CO-melder vereist bij gastoestellen.";
      return { ...item, tekst: (ctx + rest).trim() };
    }
    if (low.includes("ba uitbating") || low.includes("ba ontploffing")) {
      const tail =
        sp > 0
          ? ` Relevant voor uw verhuur met tot ${sp} slaapplaatsen volgens dossier.`
          : " Relevant voor uw uitbating van dit logies.";
      return { ...item, tekst: (item.tekst || "").trim() + tail };
    }
    return item;
  });
}

const GUIDE_REF_INCL = 100000;
const GUIDE_COMM_AT_23 = 24848;

/** YourDomi-commissie jaarbasis (incl. 21% btw): brochure-tarieven t.o.v. 23%-referentie. */
function brochureCommissionYearly(yearlyIncl, brochureFeePct) {
  const S = yearlyIncl / GUIDE_REF_INCL;
  return Math.round(GUIDE_COMM_AT_23 * S * (brochureFeePct / 23));
}

/** Brochure-tarieven (Listing / Automatisatie / Online beheer / Ontzorging). */
const BROCHURE_FEE_TIERS = [
  { pct: 10, name: "Listing", blurb: "Listing, dynamic pricing, PMS" },
  { pct: 15, name: "Automatisatie", blurb: "+ gastmodule, schoonmaakplanning" },
  { pct: 18, name: "Online beheer", blurb: "+ 24/7 communicatie, reviews" },
  { pct: 23, name: "Ontzorging", blurb: "+ schoonmaak- en onderhoudscoördinatie" },
];

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=Inter:wght@300;400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: #F7F4EF; color: #1A1A2E; min-height: 100vh; }
  .app { min-height: 100vh; background: #F7F4EF; }
  .header { background: ${TEAL_DARK}; padding: 20px 40px; display: flex; align-items: center; gap: 16px; }
  .logo-text { font-family: 'Playfair Display', serif; color: white; font-size: 22px; letter-spacing: -0.3px; }
  .logo-text span { color: ${ORANGE}; }
  .header-sub { margin-left: auto; color: rgba(255,255,255,0.5); font-size: 13px; font-weight: 300; letter-spacing: 1px; text-transform: uppercase; }
  .main { max-width: 1100px; margin: 0 auto; padding: 48px 32px; }
  .page-title { font-family: 'Playfair Display', serif; font-size: 38px; color: ${TEAL_DARK}; margin-bottom: 6px; line-height: 1.1; }
  .page-sub { color: #777; font-size: 15px; font-weight: 300; margin-bottom: 40px; }
  .form-card { background: white; border-radius: 16px; padding: 36px; box-shadow: 0 2px 24px rgba(15,79,71,0.08); margin-bottom: 32px; }
  .section-label { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${TEAL}; margin-bottom: 16px; }
  .input-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .input-group { display: flex; flex-direction: column; gap: 6px; }
  .input-group label { font-size: 13px; font-weight: 500; color: #444; }
  .input-group input, .input-group select, .input-group textarea { border: 1.5px solid #E0DDD8; border-radius: 8px; padding: 10px 14px; font-family: 'Inter', sans-serif; font-size: 14px; color: #1A1A2E; background: #FAFAF8; outline: none; transition: border-color 0.2s; }
  .input-group input:focus, .input-group select:focus, .input-group textarea:focus { border-color: ${TEAL}; background: white; }
  .input-full { grid-column: 1 / -1; }
  .dropzone { border: 2px dashed #C8C4BC; border-radius: 12px; padding: 28px; text-align: center; cursor: pointer; transition: all 0.2s; background: #FAFAF8; }
  .dropzone:hover, .dropzone.drag-over { border-color: ${TEAL}; background: ${TEAL_LIGHT}; }
  .dropzone-icon { font-size: 28px; margin-bottom: 8px; }
  .dropzone-label { font-size: 14px; color: #555; margin-bottom: 4px; }
  .dropzone-hint { font-size: 12px; color: #999; }
  .dropzone input { display: none; }
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; margin-top: 14px; }
  .photo-thumb { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; border: 2px solid #E0DDD8; }
  .photo-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .photo-remove { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.6); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .pdf-badge { display: flex; align-items: center; gap: 10px; background: ${TEAL_LIGHT}; border: 1.5px solid ${TEAL}; border-radius: 8px; padding: 10px 14px; margin-top: 12px; font-size: 13px; color: ${TEAL_DARK}; font-weight: 500; }
  .pdf-remove { margin-left: auto; background: none; border: none; color: #999; cursor: pointer; font-size: 16px; }
  .divider { height: 1px; background: #E8E2D9; margin: 28px 0; }
  .btn-generate { width: 100%; padding: 16px; background: ${TEAL}; color: white; border: none; border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s, transform 0.1s; letter-spacing: 0.3px; }
  .btn-generate:hover:not(:disabled) { background: ${TEAL_DARK}; transform: translateY(-1px); }
  .btn-generate:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-generate.loading { background: ${TEAL_DARK}; }
  .progress-card { background: white; border-radius: 16px; padding: 36px; box-shadow: 0 2px 24px rgba(15,79,71,0.08); text-align: center; margin-bottom: 32px; }
  .progress-title { font-family: 'Playfair Display', serif; font-size: 24px; color: ${TEAL_DARK}; margin-bottom: 8px; }
  .progress-sub { color: #777; font-size: 14px; margin-bottom: 28px; }
  .progress-steps { display: flex; flex-direction: column; gap: 10px; max-width: 420px; margin: 0 auto; }
  .progress-step { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 8px; font-size: 14px; transition: all 0.3s; }
  .progress-step.done { background: ${TEAL_LIGHT}; color: ${TEAL_DARK}; }
  .progress-step.active { background: #FFF3EE; color: ${ORANGE}; }
  .progress-step.pending { background: #F5F5F5; color: #AAA; }
  .step-icon { font-size: 18px; flex-shrink: 0; }
  .spinner { width: 18px; height: 18px; border: 2px solid rgba(232,98,26,0.3); border-top-color: ${ORANGE}; border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .report-wrapper { background: white; border-radius: 16px; box-shadow: 0 2px 24px rgba(15,79,71,0.08); overflow: hidden; margin-bottom: 32px; }
  .report-actions { display: flex; gap: 12px; padding: 20px 36px; background: #FAFAF8; border-bottom: 1px solid #E8E2D9; }
  .btn-action { padding: 10px 20px; border-radius: 8px; font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; border: none; }
  .btn-pdf { background: ${TEAL}; color: white; }
  .btn-pdf:hover { background: ${TEAL_DARK}; }
  .btn-reset { background: white; color: #555; border: 1.5px solid #E0DDD8; }
  .btn-reset:hover { border-color: #999; color: #222; }
  #report-content { padding: 48px; font-family: 'Inter', sans-serif; }
  .report-header { display: flex; flex-direction: column; gap: 12px; margin-bottom: 36px; padding-bottom: 24px; border-bottom: 2px solid ${TEAL}; }
  .report-header-top { display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
  .report-header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0; flex-shrink: 0; }
  .report-header-meta-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
  .report-meta { text-align: right; color: #777; font-size: 13px; line-height: 1.45; }
  .report-title { font-family: 'Playfair Display', serif; font-size: 30px; color: ${TEAL_DARK}; margin-bottom: 4px; }
  .report-address { color: #555; font-size: 15px; margin-bottom: 36px; }
  .report-section { margin-bottom: 36px; }
  .report-section-title { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${TEAL}; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #E8E2D9; }
  .report-body { font-size: 14px; line-height: 1.75; color: #333; }
  .report-body h3 { font-family: 'Playfair Display', serif; font-size: 18px; color: ${TEAL_DARK}; margin: 20px 0 8px; }
  .report-body p { margin-bottom: 10px; }
  .report-body ul { padding-left: 20px; margin-bottom: 10px; }
  .report-body li { margin-bottom: 6px; }
  .report-body strong { color: ${TEAL_DARK}; }
  .report-footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #E8E2D9; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #AAA; }
  .disclaimer { background: #F5F5F5; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #888; margin-top: 20px; line-height: 1.6; }
  .pitch-card { background: #FFFDF8; border: 1.5px solid #C8952A44; border-radius: 14px; padding: 24px; margin-bottom: 32px; position: relative; }
  .pitch-copy-btn { position: absolute; top: 16px; right: 16px; background: ${ORANGE}; color: white; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.2s; font-family: 'Inter', sans-serif; }
  .pitch-copy-btn:hover { background: #A0761C; }
  .pitch-copy-btn.copied { background: ${TEAL}; }
  .pitch-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #F0EAD8; font-size: 14px; color: #2D2A22; line-height: 1.5; }
  .pitch-item:last-child { border-bottom: none; }
  .pitch-bullet { width: 22px; height: 22px; border-radius: 50%; background: ${ORANGE}; color: white; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .fee-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .fee-table th { background: #F7F4EF; padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #777; border-bottom: 1px solid #E8E2D9; }
  .fee-table td { padding: 11px 14px; border-bottom: 1px solid #F0EDE8; color: #333; }
  .fee-table tr:last-child td { border-bottom: none; }
  .fee-table tr.fee-highlight td { background: ${TEAL_LIGHT}; font-weight: 600; color: ${TEAL_DARK}; }
  .internal-notes-block { background: #F9F9F9; border-left: 3px solid #D0C8BB; border-radius: 0 6px 6px 0; padding: 10px 14px; margin-bottom: 24px; font-size: 12px; color: #777; line-height: 1.5; }
  .internal-notes-label { font-size: 10px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #AAA; margin-bottom: 4px; }
  .score-pill {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: ${TEAL_DARK};
    border-radius: 10px;
    padding: 10px 16px 10px 12px;
    flex-shrink: 0;
  }
  .score-pill-figure {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1;
    min-width: 34px;
  }
  .score-pill-num { font-family: 'Playfair Display', serif; font-size: 26px; color: white; line-height: 1; }
  .score-pill-denom { font-size: 10px; color: rgba(255,255,255,0.5); margin-top: 3px; letter-spacing: 0.5px; }
  .score-pill-label-col { display: flex; align-items: center; min-height: 40px; }
  .score-pill-label { font-size: 10px; color: rgba(255,255,255,0.6); letter-spacing: 1.2px; text-transform: uppercase; font-weight: 600; line-height: 1.2; }
  .score-pill-reason { font-size: 12px; color: #888; font-style: italic; line-height: 1.45; text-align: right; align-self: flex-end; max-width: min(100%, 520px); margin-top: 2px; }
  @media print {
    .report-header-meta-row { flex-wrap: nowrap; }
  }
  .gids-step { display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid #F0EDE8; }
  .gids-step:last-child { border-bottom: none; }
  .gids-step-num { width: 28px; height: 28px; border-radius: 50%; background: ${TEAL}; color: white; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .gids-step-body { flex: 1; font-size: 13px; color: #333; line-height: 1.6; }
  .gids-step-title { font-weight: 600; color: ${TEAL_DARK}; margin-bottom: 3px; font-size: 14px; }
  .gids-contact { display: inline-flex; align-items: center; gap: 6px; background: ${TEAL_LIGHT}; border: 1px solid ${TEAL}22; border-radius: 6px; padding: 4px 10px; font-size: 12px; color: ${TEAL_DARK}; font-weight: 500; margin-top: 6px; text-decoration: none; }
  .gids-contact:hover { background: #D6EAE4; }
  .gids-warning { background: #FFFBEA; border-left: 3px solid ${ORANGE}; border-radius: 0 6px 6px 0; padding: 10px 14px; font-size: 12px; color: #664400; line-height: 1.6; margin-top: 8px; }
  .gids-source { font-size: 11px; color: #AAA; margin-top: 4px; }
  .gids-belasting-sub { font-size: 11px; color: #666; line-height: 1.5; margin: 0 0 14px 0; max-width: 720px; }
  .gids-belasting-table-title { font-size: 12px; font-weight: 600; color: ${TEAL_DARK}; margin: 0 0 8px 0; }
  .fiscal-adjust-panel {
    background: #FAFAF8;
    border: 1px solid #E8E2D9;
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 20px;
  }
  .fiscal-adjust-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 20px;
    align-items: end;
  }
  @media (max-width: 640px) {
    .fiscal-adjust-grid { grid-template-columns: 1fr; }
  }
  .fiscal-adjust-field label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: #555;
    margin-bottom: 4px;
    letter-spacing: 0.3px;
  }
  .fiscal-adjust-field input {
    width: 100%;
    box-sizing: border-box;
    border: 1.5px solid #E0DDD8;
    border-radius: 8px;
    padding: 8px 12px;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    background: #fff;
  }
  .fiscal-adjust-field input:focus {
    outline: none;
    border-color: ${TEAL};
  }
  .fiscal-adjust-hint { font-size: 11px; color: #999; margin-top: 10px; line-height: 1.35; }
  .cashflow-dual-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  @media (max-width: 900px) {
    .cashflow-dual-grid { grid-template-columns: 1fr; }
  }
  .cashflow-model-title { font-size: 12px; font-weight: 600; color: ${TEAL_DARK}; margin: 0 0 10px 0; }
  .fee-pill-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 16px; }
  .fee-pill {
    border: 1.5px solid #E0DDD8;
    background: #fff;
    border-radius: 999px;
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    color: #333;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    text-align: left;
    transition: border-color 0.2s, background 0.2s, color 0.2s;
  }
  .fee-pill:hover { border-color: ${TEAL}; background: ${TEAL_LIGHT}; }
  .fee-pill.active { background: ${TEAL}; color: white; border-color: ${TEAL}; }
  .fee-pill .fee-pill-pct { font-size: 14px; letter-spacing: 0.3px; }
  .fee-pill .fee-pill-name { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9; margin-top: 2px; }
  .fee-pill .fee-pill-blurb { font-size: 10px; font-weight: 400; opacity: 0.75; margin-top: 2px; max-width: 200px; line-height: 1.3; }
  .fee-pill.active .fee-pill-blurb { opacity: 0.9; }
  @media print {
    body { background: white !important; }
    .header { display: none !important; }
    .main { padding: 0 !important; max-width: 100% !important; }
    .form-card, .progress-card { display: none !important; }
    .report-wrapper { box-shadow: none !important; border-radius: 0 !important; }
    .report-actions { display: none !important; }
    #report-content { padding: 24px !important; }
    .no-print { display: none !important; }
    .report-section { break-inside: avoid; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
  @media (max-width: 700px) {
    .main { padding: 24px 16px; }
    .input-row { grid-template-columns: 1fr; }
    #report-content { padding: 24px; }
  }
`;

export default function App() {
  const [address, setAddress]               = useState("");
  const [gemeente, setGemeente]             = useState("");
  const [kamers, setKamers]                 = useState("2");
  const [slaapplaatsen, setSlaapplaatsen]   = useState("4");
  const [type, setType]                     = useState("appartement");
  const [photos, setPhotos]                 = useState([]);
  const [photoFiles, setPhotoFiles]         = useState([]);
  const [pricePdf, setPricePdf]             = useState(null);
  const [pricePdfName, setPricePdfName]     = useState("");
  const [notes, setNotes]                   = useState("");
  const [salesNotes, setSalesNotes]         = useState("");
  const [loading, setLoading]               = useState(false);
  const [currentStep, setCurrentStep]       = useState(-1);
  const [report, setReport]                 = useState(null);
  const [error, setError]                   = useState(null);
  const [dragPhoto, setDragPhoto]           = useState(false);
  const [dragPdf, setDragPdf]               = useState(false);
  const [listingUrl, setListingUrl]         = useState("");
  const [competitorUrls, setCompetitorUrls] = useState(["", ""]);
  const [startMaand, setStartMaand]         = useState(new Date().getMonth());
  const [pitchCopied, setPitchCopied]       = useState(false);
  /** Brochure-commissie (10/15/18/23%); jaarpremie commissie volgt dit tarief. */
  const [brochureFeePct, setBrochureFeePct] = useState(18);
  /** Jaarbasis afrekening (euro, ≥0); commissie incl. 21% btw volgt brochure bij wijziging pakket. */
  const [fiscJaarComm, setFiscJaarComm] = useState(0);
  const [fiscJaarSchoonmaak, setFiscJaarSchoonmaak] = useState(0);
  const [fiscJaarLinnen, setFiscJaarLinnen] = useState(0);
  const fiscalInitKeyRef = useRef("");
  const photoRef = useRef();

  useEffect(() => {
    if (report) setBrochureFeePct(18);
  }, [report]);

  useEffect(() => {
    const opt = report?.scenarios?.optimaal;
    const m = opt?.bedrag ? parseMonthlyEuroFromBedrag(opt.bedrag) : null;
    if (!report || !m || !opt) return;
    const yearlyIncl = m * 12;
    const S = yearlyIncl / GUIDE_REF_INCL;
    const key = `${report.address}|${report.gemeente}|${opt.bedrag}|${report.date || ""}`;
    if (fiscalInitKeyRef.current !== key) {
      fiscalInitKeyRef.current = key;
      setFiscJaarSchoonmaak(Math.round(18150 * S));
      setFiscJaarLinnen(Math.round(8470 * S));
    }
    setFiscJaarComm(brochureCommissionYearly(yearlyIncl, brochureFeePct));
  }, [report, brochureFeePct]);
  const pdfRef   = useRef();

  const addPhotos = useCallback(async (files) => {
    const arr = Array.from(files).filter(f => f.type.startsWith("image/")).slice(0, 10 - photos.length);
    const urls = await Promise.all(arr.map(fileToDataUrl));
    setPhotos(p => [...p, ...urls]);
    setPhotoFiles(p => [...p, ...arr]);
  }, [photos.length]);

  const removePhoto = (i) => {
    setPhotos(p => p.filter((_, idx) => idx !== i));
    setPhotoFiles(p => p.filter((_, idx) => idx !== i));
  };

  const addPdf = (file) => {
    if (!file || file.type !== "application/pdf") return;
    setPricePdf(file);
    setPricePdfName(file.name);
  };

  const canGenerate = address.trim() && gemeente.trim();

  const STEPS = [
    { id: "pdf",      label: pricePdf ? "PriceLabs rapport analyseren" : "Marktdata ophalen via web", icon: pricePdf ? "📄" : "🌐" },
    { id: "photos",   label: "Foto's beoordelen",                icon: "🖼️" },
    { id: "urls",     label: "Listings ophalen & analyseren",    icon: "🔗" },
    { id: "search",   label: "Marktdata verwerken",              icon: "🔍" },
    { id: "analysis", label: "AI-analyse uitvoeren",             icon: "🧠" },
    { id: "report",   label: "Rapport samenstellen",             icon: "📊" },
  ];

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const copyPitch = (pts) => {
    navigator.clipboard.writeText(pts.map((p, i) => `${i + 1}. ${p}`).join("\n")).then(() => {
      setPitchCopied(true);
      setTimeout(() => setPitchCopied(false), 2000);
    });
  };

  const scoreColor = (s) => {
    if (s >= 8) return "#1E6B4A";
    if (s >= 6) return TEAL_DARK;
    if (s >= 4) return "#8A6700";
    return "#8B2E00";
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    setReport(null);
    setCurrentStep(0);

    try {
      await sleep(600); setCurrentStep(1);
      await sleep(500); setCurrentStep(2);
      await sleep(400); setCurrentStep(3);

      let listingData = "";
      let competitorData = "";

      const fetchUrl = async (url) => {
        if (!url || !url.startsWith("http")) return null;
        try {
          const r = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 2000,
              tools: [{ type: "web_search_20250305", name: "web_search" }],
              messages: [{ role: "user", content: `Haal de volgende pagina op en extraheer: prijs per nacht, bezetting, beoordelingen, reviews, type, capaciteit, beschrijving, amenities. URL: ${url}\nGeef een gestructureerde samenvatting in het Nederlands.` }]
            })
          });
          const parsed = await parseJsonSafe(r);
          if (!parsed.ok) return null;
          const d = parsed.data;
          if (!r.ok || d?.error) return null;
          return d.content?.filter(b => b.type === "text").map(b => b.text).join("") || null;
        } catch { return null; }
      };

      if (listingUrl) listingData = await fetchUrl(listingUrl) || "Kon listing niet ophalen.";
      for (const url of competitorUrls.filter(u => u.trim())) {
        const d = await fetchUrl(url);
        if (d) competitorData += `\n---\nConcurrent (${url}):\n${d}`;
      }

      await sleep(300); setCurrentStep(3); await sleep(400);

      const content = [];

      for (const file of photoFiles.slice(0, 6)) {
        const ready = await compressImageForApi(file);
        const b64 = await toBase64(ready);
        content.push({
          type: "image",
          source: { type: "base64", media_type: ready.type || "image/jpeg", data: b64 },
        });
      }

      if (pricePdf) {
        const b64 = await toBase64(pricePdf);
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
      }

      const propInfo = `Adres: ${address}, ${gemeente}\nType: ${type}\nSlaapkamers: ${kamers}\nSlaapplaatsen: ${slaapplaatsen}\nExtra info: ${notes || "Geen"}`;

      const dataSource = pricePdf
        ? "PriceLabs marktrapport beschikbaar als bijlage — gebruik als primaire bron."
        : `Geen marktrapport. Gebruik web_search voor actuele Airbnb marktdata in ${gemeente}, België (bezetting, ADR, seizoen).`;

      content.push({ type: "text", text: `Je bent een senior vastgoedstrateeg bij YourDomi. Schrijf een rentabiliteitsrapport voor een eigenaar die overweegt zijn woning te laten beheren.

STIJL: Vloeiend professioneel Nederlands. Nooit vermelden: PriceLabs, AI, algoritme, databronnen. Schrijf als consultant die de eigenaar persoonlijk adviseert. Zeg "dit pand" of "uw woning".

EIGENDOMSINFO:
${propInfo}
${photoFiles.length > 0 ? `${photoFiles.length} foto's beschikbaar.` : ""}
${listingData ? `BESTAANDE LISTING:\n${listingData}` : ""}
${competitorData ? `CONCURRENTEN:\n${competitorData}` : ""}

DATABRON: ${dataSource}

RAPPORT IN PLAIN HTML — alleen: h3, p, ul, li, strong. GEEN markdown, GEEN sterretjes.
VERBODEN: geen <table> en geen tabellen. Geen matrix "netto-inkomsten (eigenaar) na YourDomi-fee" met pakketten (Starter/Standard/Premium/Full Service of 10%/20%/25%/30%) en kolommen Conservatief/Realistisch/Optimaal — dat toont de applicatie zelf, niet uw tekst.

Voeg BOVENAAN toe:
<deal-score>X:uitleg</deal-score> met X = integer 1–10 en uitleg max 12 woorden.
Deal-score kalibratie (verplicht): 5 = neutraal/marktgemiddelde; 6–7 = duidelijk boven gemiddeld; 8+ alleen bij uitzonderlijke differentiatie of rendement. Geef niet routinematig 7–8 — wees kritisch.

Dan secties:

<h3>Samenvatting</h3>
<p>2-3 zinnen over het pand en het potentieel.</p>

<h3 id="scenarios">Omzetscenario's</h3>
<p>Conservatief verhaal. <strong>Conservatief: €X.XXX/maand</strong> bij XX% bezetting en €XXX ADR.</p>
<p>Realistisch verhaal. <strong>Realistisch: €X.XXX/maand</strong> bij XX% bezetting en €XXX ADR.</p>
<p>Optimaal verhaal. <strong>Optimaal: €X.XXX/maand</strong> bij XX% bezetting en €XXX ADR.</p>
<p>Voeg hier GEEN extra tabel of vergelijkingsmatrix toe over beheerpakketten of netto na fee — enkel deze drie paragrafen.</p>

<h3>Prijsstrategie</h3>
<p>Pricing filosofie in 1-2 zinnen.</p>
<ul>
<li><strong>Minimumprijs:</strong> €XXX</li>
<li><strong>Weekendopslag:</strong> XX%</li>
<li><strong>Hoogseizoen:</strong> maanden en prijsrange</li>
<li><strong>Last-minute:</strong> strategie</li>
</ul>

<h3>Groeistrategie</h3>
<p><strong>Fase 1 (Maand 1-3) — Opbouw:</strong> verhaal. Verwachte omzet: €X.XXX/maand</p>
<p><strong>Fase 2 (Maand 4-6) — Consolidatie:</strong> verhaal. Verwachte omzet: €X.XXX/maand</p>
<p><strong>Fase 3 (Maand 7-12) — Optimalisatie:</strong> verhaal. Verwachte omzet: €X.XXX/maand</p>
<p><strong>Jaar 2:</strong> langetermijnperspectief. Verwachte omzet: €X.XXX/maand</p>

<h3>Concurrentieanalyse</h3>
<p>Marktpositie en kansen vanuit perspectief van dit pand.</p>

<h3>Fotografie & Presentatie</h3>
<p>1 zin over fotografie voor dit pand.</p>
<ul><li>...</li></ul>

<h3>Verkoopspitch</h3>
<p>3 punchlines voor het salesgesprek — kort, overtuigend, max 20 woorden per punt.</p>
<ul>
<li><strong>Punt 1:</strong> [punchline]</li>
<li><strong>Punt 2:</strong> [punchline]</li>
<li><strong>Punt 3:</strong> [punchline]</li>
</ul>

<h3>YourDomi Aanbeveling</h3>
<p>Welk pakket uit de brochure (10%/15%/18%/23%) en waarom — 2 zinnen.</p>
<ul><li>Actiepunt 1</li><li>Actiepunt 2</li><li>Actiepunt 3</li></ul>

Voeg na het rapport toe (gebruik web_search voor city-specifieke info):

<praktische-gids>
<vergunning>
Zoek via web_search de exacte procedure voor kortetermijnverhuur in ${gemeente}, België. Queries: "toeristische logies registratie ${gemeente}", "omgevingsvergunning kortetermijnverhuur ${gemeente}". Schrijf een concreet stappenplan (max 5 stappen):
<stap n="1"><titel>Stap titel</titel><tekst>Wat concreet te doen.</tekst><contact><naam>Naam dienst</naam><url>https://...</url></contact></stap>
Includeer links naar Toerisme Vlaanderen/Brussels/Wallonie (afhankelijk van regio), de omgevingsdienst van ${gemeente}, en lokale brandweer.
</vergunning>
<brandweer>
Dossier-pand (uit formulier — niet verzinnen): adres **${address}**, gemeente **${gemeente}**, type **${type}**, **${kamers} slaapkamers**, **${slaapplaatsen} slaapplaatsen**.

VERPLICHT — open elk <item> met één korte zin die dit pand expliciet noemt (straat of gemeente + type + capaciteit), daarna de algemene uitleg. Geen generiek advies zonder koppeling aan dit object.

Zoek via web_search: "brandweer ${gemeente}" of "brandweerzone ${gemeente}". Geef praktische vereisten voor vakantieverhuur **precies voor deze capaciteit en dit adres**.

Conformiteitsattest — logica (toepassen in <tekst>, geen tegenstrijdige uitspraken):
- Als **${slaapplaatsen}** (als geheel getal) **> 8**: leg uit dat keuring + conformiteitsattest doorgaans aangewezen zijn; verwijs naar lokale brandweerzone.
- Als **≤ 8**: leg uit dat dit **onder of gelijk aan** de veelgebruikte drempel "meer dan 8 slaapplaatsen" valt, dat verplichtingen **doorgaans lichter** zijn, en dat **lokale bevestiging** bij de brandweerzone nodig blijft. **Schrijf nooit** dat er "meer dan 8 slaapplaatsen" zijn als dat niet klopt.

Rookmelders: koppel aan **${kamers} slaapkamers** (minstens één rookmelder per slaapkamer) en elke verdieping; CO bij gastoestellen.

Vermeld expliciet verzekeringen voor uitbaters: **BA uitbating** en **BA ontploffing** (objectieve dekking brand/ontploffing).
BELANGRIJK: geen link naar een verzekeringsmakelaar of -adviseur. Enkel (optioneel) informatieve artikelen over BA uitbating en BA brand/ontploffing.

<item><titel>Rookmelders & CO-detectie</titel><tekst>Korte tekst die ${kamers} slaapkamers en ${slaapplaatsen} slaapplaatsen expliciet noemt + verplichtingen.</tekst><contact><naam>Brandweerzone ${gemeente}</naam><url>https://...</url></contact></item>
<item><titel>Conformiteitsattest</titel><tekst>Korte tekst conform bovenstaande drempel-logica voor precies ${slaapplaatsen} slaapplaatsen.</tekst><contact><naam>Lokale brandweerzone</naam><url>https://...</url></contact></item>
<item><titel>BA uitbating</titel><tekst>BA uitbating: dekking schade aan derden door uitbatingsactiviteiten (relevant voor uw verhuur met ${slaapplaatsen} slaapplaatsen).</tekst><contact><naam>Meer info</naam><url>https://www.creativeshelter.be/knowledge-hub/wat-is-een-ba-uitbating</url></contact></item>
<item><titel>BA ontploffing (objectieve dekking)</titel><tekst>BA ontploffing: objectieve aansprakelijkheid bij brand/ontploffing jegens derden.</tekst><contact><naam>Meer info</naam><url>https://ag.be/professioneel/nl/bescherming-gezin-onderneming/aansprakelijkheid-bed-en-bestuurder/objectieve-aansprakelijkheid-brand-en-ontploffing</url></contact></item>
</brandweer>
</praktische-gids>

BELANGRIJK: Schrijf ALLEEN de HTML + deal-score tag + praktische-gids blok. Geen JSON. Geen extra tekst. Geen <belasting>-sectie — fiscale uitleg staat niet in de gids; enkel vergunning + brandveiligheid.` });

      setCurrentStep(4);

      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 6000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content }]
        })
      });

      const parsed = await parseJsonSafe(resp);
      if (!parsed.ok) {
        const snippet = (parsed.raw || "").slice(0, 220).replace(/\s+/g, " ").trim();
        throw new Error(`API gaf geen JSON terug (status ${resp.status}). ${snippet || "Lege response."}`);
      }
      const data = parsed.data;
      if (!resp.ok || data.error) {
        const msg =
          data?.error?.message ||
          data?.error ||
          data?.details ||
          `Status ${resp.status}`;
        throw new Error(`API fout: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      }
      if (!data.content) throw new Error(`Geen response van API. Status: ${resp.status}.`);

      const fullText = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");

      // Parse deal score (1–10; model wordt via prompt naar neutrale kalibratie gestuurd, rond 5)
      let dealScore = null;
      const dsMatch = fullText.match(/<deal-score>\s*(\d{1,2})\s*:\s*([^<]+)\s*<\/deal-score>/i);
      if (dsMatch) {
        let score = parseInt(dsMatch[1], 10);
        if (!Number.isFinite(score)) score = 5;
        score = Math.min(10, Math.max(1, score));
        dealScore = { score, reason: dsMatch[2].trim() };
      }

      // Parse scenarios
      const parseEuro = (str) => parseInt(str.replace(/\./g, "")) || 0;
      const plainText = fullText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const extractScenario = (label) => {
        const prim = new RegExp("\\b" + label + "\\s*:+\\s*€([\\d][\\d\\.]+)\\s*(?:\\/maand|per maand)?\\s+bij\\s+(\\d{2,3})%\\s+bezetting\\s+en\\s+€(\\d{2,4})", "i");
        const mP = plainText.match(prim);
        if (mP) return { bedrag: "€" + mP[1], bezetting: mP[2] + "%", adr: "€" + mP[3] };
        const sec = new RegExp("\\b" + label + "\\s*:+[^€]{0,30}€([\\d]+\\.[\\d]{3})[\\s\\S]{0,80}?(\\d{2,3})%[\\s\\S]{0,40}?€(\\d{2,4})\\s*ADR", "i");
        const mS = plainText.match(sec);
        if (mS) return { bedrag: "€" + mS[1], bezetting: mS[2] + "%", adr: "€" + mS[3] };
        const ter = new RegExp("\\b" + label + "\\s*:+[^€]{0,20}€([\\d]+\\.[\\d]{3})", "i");
        const mT = plainText.match(ter);
        return mT ? { bedrag: "€" + mT[1], bezetting: "—", adr: "—" } : null;
      };
      const sc = extractScenario("Conservatief");
      const sr = extractScenario("Realistisch");
      const so = extractScenario("Optimaal");
      const scenarios = (sc || sr || so) ? { conservatief: sc, realistisch: sr, optimaal: so } : null;

      // Parse pitch points
      let pitchPoints = [];
      const pitchSection = fullText.match(/<h3>Verkoopspitch<\/h3>([\s\S]*?)(?=<h3>|$)/i);
      if (pitchSection) {
        for (const m of pitchSection[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
          const clean = m[1].replace(/<strong>[^<]*<\/strong>:?\s*/i, "").replace(/<[^>]+>/g, "").trim();
          if (clean) pitchPoints.push(clean);
        }
      }

      // Parse ramp-up
      const SEIZOEN = [0.35,0.38,0.55,0.70,0.85,1.05,1.80,2.10,1.15,0.72,0.45,0.38];
      const MAAND_NAMEN = ["jan","feb","mrt","apr","mei","jun","jul","aug","sep","okt","nov","dec"];
      const MAAND_LANG = ["Januari","Februari","Maart","April","Mei","Juni","Juli","Augustus","September","Oktober","November","December"];
      const seizoenFromPdf = [...SEIZOEN];
      const maandMap = {jan:0,feb:1,mrt:2,apr:3,mei:4,jun:5,jul:6,aug:7,sep:8,okt:9,nov:10,dec:11,januari:0,februari:1,maart:2,april:3,juni:5,juli:6,augustus:7,september:8,oktober:9};
      let foundSeizoen = false;
      for (const m of plainText.matchAll(/\b(jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec|januari|februari|maart|april|juni|juli|augustus|september|oktober|november|december)[^\d]{0,5}(\d{2,3})%/gi)) {
        const idx = maandMap[m[1].toLowerCase()];
        if (idx !== undefined) { seizoenFromPdf[idx] = parseInt(m[2]) / 60; foundSeizoen = true; }
      }

      const realistischVal = sr ? parseEuro((sr.bedrag || "").replace("€","")) : 4000;
      const extractFaseAmount = (label) => {
        const m = plainText.match(new RegExp(label + "[\\s\\S]{0,500}€([1-9]\\d{0,1}\\.[\\d]{3})", "i"));
        return m ? parseEuro(m[1]) : null;
      };
      const f1 = extractFaseAmount("Fase 1") || Math.round(realistischVal * 0.6);
      const f2 = extractFaseAmount("Fase 2") || Math.round(realistischVal * 0.85);
      const f3 = extractFaseAmount("Fase 3") || realistischVal;
      const f4 = extractFaseAmount("Jaar 2")  || Math.round(f3 * 1.2);

      const faseRamp = [[0.65,0.80,1.0],[0.85,1.0,1.12],[0.92,1.0,0.97,0.87,0.77,0.72]];
      const rampup = [];
      for (let m = 0; m < 12; m++) {
        const cal = (startMaand + m) % 12;
        let faseNum, base, rf;
        if (m < 3)  { faseNum=1; base=f1; rf=faseRamp[0][m]; }
        else if (m<6){ faseNum=2; base=f2; rf=faseRamp[1][m-3]; }
        else          { faseNum=3; base=f3; rf=faseRamp[2][m-6]; }
        rampup.push({ maand:MAAND_NAMEN[cal], label:MAAND_LANG[cal]+" (M"+(m+1)+")", omzet:Math.round(base*rf*seizoenFromPdf[cal]), fase:faseNum });
      }
      const qF = (mi) => (seizoenFromPdf[mi]+seizoenFromPdf[(mi+1)%12]+seizoenFromPdf[(mi+2)%12])/3;
      for (let q=0;q<4;q++) {
        const qm = (startMaand+12+q*3)%12;
        rampup.push({ maand:`Jaar 2 Q${q+1}`, label:`Jaar 2 Q${q+1}`, omzet:Math.round(f4*qF(qm)*3*1.1), fase:4 });
      }

      // Clean HTML
      let html = fullText
        .replace(/<deal-score>[^<]*<\/deal-score>/gi,"")
        .replace(/,?"realistisch":\{[^}]+\}[,]?"optimaal":\{[^}]+\}/g,"")
        .replace(/,?"conservatief":\{[^}]+\}[,]?/g,"")
        .replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g,"<em>$1</em>")
        .replace(/^#{1,3} (.+)$/gm,"<h3>$1</h3>")
        .replace(/^[-•] (.+)$/gm,"<li>$1</li>")
        .replace(/^\d+\. (.+)$/gm,"<li>$1</li>")
        .replace(/<section[^>]*>/g,"").replace(/<\/section>/g,"")
        .trim();

      html = html.split("\n").reduce((acc,line) => {
        const t = line.trim();
        if (!t) { acc.push(""); return acc; }
        const last = acc[acc.length-1]||"";
        if (last && !last.endsWith(">") && !t.startsWith("<")) acc[acc.length-1] = last+" "+t;
        else acc.push(t);
        return acc;
      },[]).join("\n");

      const lines2 = html.split("\n"); const result = []; let i=0;
      while(i<lines2.length){
        const l=lines2[i].trim();
        if(!l){i++;continue;}
        if(l.startsWith("<li>")){
          let u="";
          while(i<lines2.length&&lines2[i].trim().startsWith("<li>")){u+=lines2[i].trim();i++;}
          result.push("<ul>"+u+"</ul>");
        } else if(l.startsWith("<")){result.push(l);i++;}
        else{result.push("<p>"+l+"</p>");i++;}
      }
      html = result.join("\n").replace(/<p>\s*<\/p>/g,"");
      html = stripLegacyPackageNettoTables(html);

      // Parse praktische gids block
      let praktischeGids = null;
      const gidsMatch = fullText.match(/<praktische-gids>([\s\S]*?)<\/praktische-gids>/i);
      if (gidsMatch) {
        const g = gidsMatch[1];
        const stappen = [...g.matchAll(/<stap[^>]*n="(\d+)"[^>]*>([\s\S]*?)<\/stap>/gi)].map(m => ({
          n: m[1],
          titel: (m[2].match(/<titel>([\s\S]*?)<\/titel>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          tekst: (m[2].match(/<tekst>([\s\S]*?)<\/tekst>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          contactNaam: (m[2].match(/<naam>([\s\S]*?)<\/naam>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          contactUrl:  (m[2].match(/<url>([\s\S]*?)<\/url>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
        }));
        const parseBrandweer = (raw) => [...raw.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => ({
          titel: (m[1].match(/<titel>([\s\S]*?)<\/titel>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          tekst: (m[1].match(/<tekst>([\s\S]*?)<\/tekst>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          contactNaam: (m[1].match(/<naam>([\s\S]*?)<\/naam>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
          contactUrl:  (m[1].match(/<url>([\s\S]*?)<\/url>/i)||[])[1]?.replace(/<[^>]+>/g,"").trim()||"",
        }));
        const bwRaw  = (g.match(/<brandweer>([\s\S]*?)<\/brandweer>/i)||[])[1]||"";
        praktischeGids = {
          stappen: stappen.length ? stappen : null,
          brandweer: tailorBrandweerToInput(parseBrandweer(bwRaw), { slaapplaatsen, kamers, type, gemeente }),
        };
      }
      // Remove gids block from html body
      html = html.replace(/<praktische-gids>[\s\S]*?<\/praktische-gids>/gi,"").trim();
      html = stripLegacyPackageNettoTables(html);

      setCurrentStep(5);
      await sleep(400);

      setReport({
        html, scenarios, rampup, dealScore, pitchPoints, praktischeGids,
        address, gemeente, type, kamers, slaapplaatsen,
        startMaand, seizoenUitPdf: foundSeizoen,
        salesNotes: salesNotes.trim(),
        date: new Date().toLocaleDateString("nl-BE", { day:"numeric", month:"long", year:"numeric" })
      });

    } catch (e) {
      setError(`Er ging iets mis: ${e.message||e}. Check de console voor details.`);
      console.error("Full error:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <header className="header">
          <span className="logo-text">YourDomi<span>.</span></span>
          <div className="header-sub">Eigendomsanalyse — Intern</div>
        </header>

        <main className="main">
          <h1 className="page-title">Eigendomsanalyse</h1>
          <p className="page-sub">Vul de gegevens in voor een AI-analyse. PriceLabs rapport en foto's zijn optioneel maar verbeteren de nauwkeurigheid.</p>

          {!report && (
            <>
              <div className="form-card">
                <div className="section-label">Eigendomsgegevens</div>
                <div className="input-row">
                  <div className="input-group input-full">
                    <label>Volledig adres</label>
                    <input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Kerkstraat 12, 9000 Gent" />
                  </div>
                  <div className="input-group">
                    <label>Gemeente / stad</label>
                    <input value={gemeente} onChange={e=>setGemeente(e.target.value)} placeholder="Gent" />
                  </div>
                  <div className="input-group">
                    <label>Type pand</label>
                    <select value={type} onChange={e=>setType(e.target.value)}>
                      <option value="appartement">Appartement</option>
                      <option value="woning">Woning</option>
                      <option value="studio">Studio</option>
                      <option value="villa">Villa</option>
                      <option value="vakantiewoning">Vakantiewoning</option>
                    </select>
                  </div>
                  <div className="input-group">
                    <label>Slaapkamers</label>
                    <select value={kamers} onChange={e=>setKamers(e.target.value)}>
                      {["1","2","3","4","5","6+"].map(v=><option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div className="input-group">
                    <label>Max. slaapplaatsen</label>
                    <select value={slaapplaatsen} onChange={e=>setSlaapplaatsen(e.target.value)}>
                      {["2","3","4","5","6","7","8","10","12+"].map(v=><option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div className="input-group">
                    <label>Verwachte startmaand verhuur</label>
                    <select value={startMaand} onChange={e=>setStartMaand(parseInt(e.target.value))}>
                      {["Januari","Februari","Maart","April","Mei","Juni","Juli","Augustus","September","Oktober","November","December"].map((m,i)=>(
                        <option key={i} value={i}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div className="input-group">
                    <label>Extra info pand (optioneel)</label>
                    <input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Zwembad, parking, nabij station..." />
                  </div>
                </div>

                <div className="divider" />

                <div className="section-label">Interne salesnotities <span style={{fontWeight:400,color:"#888",fontSize:11}}>— niet afgedrukt, enkel intern zichtbaar</span></div>
                <div className="input-row">
                  <div className="input-group input-full">
                    <label>Context voor het salesgesprek</label>
                    <textarea value={salesNotes} onChange={e=>setSalesNotes(e.target.value)} rows={3}
                      placeholder="bv. eigenaar twijfelt, slechte ervaring met vorige beheerder, wil min. €1.500/maand netto, referentie via..." />
                  </div>
                </div>

                <div className="divider" />

                <div className="section-label">Listing URLs (optioneel)</div>
                <div className="input-row">
                  <div className="input-group input-full">
                    <label>Bestaande listing van dit pand</label>
                    <input value={listingUrl} onChange={e=>setListingUrl(e.target.value)} placeholder="https://www.airbnb.com/rooms/..." />
                  </div>
                  <div className="input-group">
                    <label>Concurrent 1</label>
                    <input value={competitorUrls[0]} onChange={e=>setCompetitorUrls(u=>[e.target.value,u[1]])} placeholder="https://www.airbnb.com/rooms/..." />
                  </div>
                  <div className="input-group">
                    <label>Concurrent 2</label>
                    <input value={competitorUrls[1]} onChange={e=>setCompetitorUrls(u=>[u[0],e.target.value])} placeholder="https://www.airbnb.com/rooms/..." />
                  </div>
                </div>

                <div className="divider" />

                <div className="section-label">Foto's van het pand</div>
                <div className={`dropzone ${dragPhoto?"drag-over":""}`}
                  onDragOver={e=>{e.preventDefault();setDragPhoto(true);}}
                  onDragLeave={()=>setDragPhoto(false)}
                  onDrop={e=>{e.preventDefault();setDragPhoto(false);addPhotos(e.dataTransfer.files);}}
                  onClick={()=>photoRef.current.click()}>
                  <div className="dropzone-icon">🖼️</div>
                  <div className="dropzone-label">Sleep foto's hierheen of klik om te uploaden</div>
                  <div className="dropzone-hint">JPG, PNG · max 10 foto's</div>
                  <input ref={photoRef} type="file" accept="image/*" multiple onChange={e=>addPhotos(e.target.files)} />
                </div>
                {photos.length>0&&(
                  <div className="photo-grid">
                    {photos.map((src,i)=>(
                      <div key={i} className="photo-thumb">
                        <img src={src} alt={`foto ${i+1}`} />
                        <button className="photo-remove" onClick={()=>removePhoto(i)}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="divider" />

                <div className="section-label">PriceLabs rapport (PDF) <span style={{fontWeight:400,color:"#888",fontSize:11}}>— optioneel, verhoogt nauwkeurigheid</span></div>
                <div className={`dropzone ${dragPdf?"drag-over":""}`}
                  onDragOver={e=>{e.preventDefault();setDragPdf(true);}}
                  onDragLeave={()=>setDragPdf(false)}
                  onDrop={e=>{e.preventDefault();setDragPdf(false);addPdf(e.dataTransfer.files[0]);}}
                  onClick={()=>pdfRef.current.click()}>
                  <div className="dropzone-icon">📄</div>
                  <div className="dropzone-label">Sleep het PriceLabs PDF-rapport hierheen (optioneel)</div>
                  <div className="dropzone-hint">Zonder PDF gebruikt de AI live marktdata via web search</div>
                  <input ref={pdfRef} type="file" accept="application/pdf" onChange={e=>addPdf(e.target.files[0])} />
                </div>
                {pricePdfName&&(
                  <div className="pdf-badge">
                    <span>📄</span><span>{pricePdfName}</span>
                    <button className="pdf-remove" onClick={()=>{setPricePdf(null);setPricePdfName("");}}>×</button>
                  </div>
                )}
              </div>

              {error&&(
                <div style={{background:"#FFF0EE",border:"1.5px solid #C8952A",borderRadius:10,padding:"14px 18px",color:"#774010",fontSize:14,marginBottom:16}}>
                  ⚠️ {error}
                </div>
              )}

              <button className={`btn-generate ${loading?"loading":""}`} onClick={generate} disabled={!canGenerate||loading}>
                {loading?"Analyseren...":"🧠  Rapport genereren"}
              </button>
            </>
          )}

          {loading&&(
            <div className="progress-card" style={{marginTop:24}}>
              <div className="progress-title">Analyse bezig...</div>
              <div className="progress-sub">Even geduld — Claude analyseert het pand en de markt.</div>
              <div className="progress-steps">
                {STEPS.map((s,i)=>(
                  <div key={s.id} className={`progress-step ${i<currentStep?"done":i===currentStep?"active":"pending"}`}>
                    {i<currentStep?<span className="step-icon">✅</span>:i===currentStep?<div className="spinner"/>:<span className="step-icon">{s.icon}</span>}
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report&&(
            <div className="report-wrapper">
              <div className="report-actions">
                <button className="btn-action btn-pdf" onClick={()=>window.print()}>🖨️ PDF afdrukken / downloaden</button>
                <button className="btn-action btn-reset" onClick={()=>{setReport(null);setError(null);}}>← Nieuw rapport</button>
              </div>

              <div id="report-content">

                {/* HEADER */}
                <div className="report-header">
                  <div className="report-header-top">
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                      <span style={{ fontFamily: "'Playfair Display',serif", fontSize: 26, color: "#2D4A3E" }}>
                        YourDomi<span style={{ color: "#C8952A" }}>.</span>
                      </span>
                      <div style={{ color: "#999", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase" }}>Rentabiliteitsanalyse</div>
                    </div>
                    <div className="report-header-right">
                      <div className="report-header-meta-row">
                        {report.dealScore && (
                          <div className="score-pill" style={{ background: scoreColor(report.dealScore.score) }}>
                            <div className="score-pill-figure">
                              <span className="score-pill-num">{report.dealScore.score}</span>
                              <span className="score-pill-denom">/10</span>
                            </div>
                            <div className="score-pill-label-col">
                              <span className="score-pill-label">Deal score</span>
                            </div>
                          </div>
                        )}
                        <div className="report-meta">
                          {report.date}
                          <br />
                          {report.type} · {report.kamers} slaapkamers · {report.slaapplaatsen} slaapplaatsen
                        </div>
                      </div>
                    </div>
                  </div>
                  {report.dealScore && <div className="score-pill-reason">{report.dealScore.reason}</div>}
                </div>

                <div className="report-title">Rentabiliteitsrapport</div>
                <div className="report-address">{report.address}, {report.gemeente}</div>

                {/* INTERNAL NOTES — no print */}
                {report.salesNotes&&(
                  <div className="internal-notes-block no-print">
                    <div className="internal-notes-label">📝 Interne notities</div>
                    <div>{report.salesNotes}</div>
                  </div>
                )}

                {/* QUICK PITCH — no print */}
                {report.pitchPoints?.length>0&&(
                  <div className="pitch-card no-print">
                    <div style={{fontSize:11,fontWeight:700,letterSpacing:2,textTransform:"uppercase",color:ORANGE,marginBottom:14}}>🎯 Verkoopspitch</div>
                    <button className={`pitch-copy-btn ${pitchCopied?"copied":""}`} onClick={()=>copyPitch(report.pitchPoints)}>
                      {pitchCopied?"✓ Gekopieerd":"Kopieer punten"}
                    </button>
                    {report.pitchPoints.map((p,i)=>(
                      <div key={i} className="pitch-item">
                        <div className="pitch-bullet">{i+1}</div>
                        <span>{p}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* SCENARIO CARDS */}
                {report.scenarios&&(()=>{
                  const sc=report.scenarios;
                  const vals=["conservatief","realistisch","optimaal"].map(k=>parseInt((sc[k]?.bedrag||"0").replace(/[€\.]/g,""))||0);
                  const maxVal=Math.max(...vals);
                  const cfgs=[
                    {key:"conservatief",label:"Conservatief",color:"#7EB8B0",bg:"#F0FAF9",pct:Math.round((vals[0]/maxVal)*100)},
                    {key:"realistisch", label:"Realistisch", color:"#4A7C6B",bg:"#EBF2EF",pct:Math.round((vals[1]/maxVal)*100),featured:true},
                    {key:"optimaal",    label:"Optimaal",    color:"#C8952A",bg:"#FFF3EE",pct:Math.round((vals[2]/maxVal)*100)},
                  ];
                  return (
                    <div className="report-section">
                      <div className="report-section-title">Omzetscenario's per maand</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:16}}>
                        {cfgs.map(cfg=>(
                          <div key={cfg.key} style={{background:cfg.featured?"#2D4A3E":cfg.bg,borderRadius:14,padding:"20px 16px",position:"relative",overflow:"hidden",border:cfg.featured?"none":`1.5px solid ${cfg.color}22`}}>
                            {cfg.featured&&<div style={{position:"absolute",top:0,right:0,background:"#C8952A",color:"white",fontSize:10,fontWeight:700,padding:"4px 10px",borderRadius:"0 14px 0 8px",letterSpacing:1}}>AANBEVOLEN</div>}
                            <div style={{fontSize:11,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:cfg.featured?"#7EB8B0":cfg.color,marginBottom:8}}>{cfg.label}</div>
                            <div style={{fontFamily:"Playfair Display,serif",fontSize:28,color:cfg.featured?"white":"#1A1A2E",marginBottom:4,lineHeight:1}}>{sc[cfg.key]?.bedrag||"—"}</div>
                            <div style={{fontSize:11,color:cfg.featured?"#AAD4CF":"#888",marginBottom:14}}>per maand</div>
                            <div style={{display:"flex",gap:8,fontSize:11,color:cfg.featured?"#7EB8B0":"#777",marginBottom:12}}>
                              <span>📊 {sc[cfg.key]?.bezetting}</span>
                              <span>💶 {sc[cfg.key]?.adr} ADR</span>
                            </div>
                            <div style={{background:cfg.featured?"#0A3B35":"#E8E4DE",borderRadius:4,height:4,overflow:"hidden"}}>
                              <div style={{width:`${cfg.pct}%`,height:"100%",background:cfg.featured?"#6AAF9A":cfg.color,borderRadius:4}} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* GROWTH CHART */}
                {report.rampup&&(()=>{
                  const yr1=report.rampup.filter(d=>d.fase<=3);
                  const yr2=report.rampup.filter(d=>d.fase===4);
                  const yr1tot=yr1.reduce((s,d)=>s+d.omzet,0);
                  const yr2tot=yr2.reduce((s,d)=>s+d.omzet,0);
                  const faseColors={1:"#A8C5BB",2:"#6AAF9A",3:"#4A7C6B"};
                  const faseLabels={1:"Opbouw",2:"Consolidatie",3:"Optimalisatie"};
                  const Tip=({active,payload,label})=>{
                    if(!active||!payload?.length)return null;
                    const d=payload[0].payload;
                    return <div style={{background:"white",border:"1px solid #E8E4DE",borderRadius:10,padding:"10px 14px",fontSize:12,boxShadow:"0 4px 12px rgba(0,0,0,0.08)"}}>
                      <div style={{fontWeight:600,color:"#2D4A3E",marginBottom:3}}>{label}</div>
                      <div style={{color:"#4A7C6B",fontSize:15,fontWeight:700}}>€{payload[0].value?.toLocaleString("nl-BE")}</div>
                      <div style={{color:"#999",marginTop:2}}>{faseLabels[d.fase]||"Jaar 2"}</div>
                    </div>;
                  };
                  return (
                    <div className="report-section">
                      <div className="report-section-title">Groeitraject — Jaar 1 & 2</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:20}}>
                        {[
                          {label:"Jaar 1 omzet (totaal)",val:`€${yr1tot.toLocaleString("nl-BE")}`,color:"#4A7C6B"},
                          {label:"Gem. per maand Jaar 1",val:`€${Math.round(yr1tot/12).toLocaleString("nl-BE")}`,color:"#4A7C6B"},
                          {label:"Jaar 2 prognose",val:`€${yr2tot.toLocaleString("nl-BE")}`,color:"#C8952A"},
                        ].map((k,i)=>(
                          <div key={i} style={{background:"#F7F4EF",borderRadius:10,padding:"14px 16px",textAlign:"center"}}>
                            <div style={{fontSize:11,color:"#999",marginBottom:6}}>{k.label}</div>
                            <div style={{fontFamily:"Playfair Display,serif",fontSize:20,color:k.color}}>{k.val}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{background:"white",borderRadius:12,padding:"20px 16px 12px",marginBottom:12}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
                          <span style={{fontSize:12,color:"#999"}}>Maandelijkse omzetprognose Jaar 1 — seizoensgecorrigeerd</span>
                          {report.seizoenUitPdf
                            ?<span style={{fontSize:10,background:"#EBF2EF",color:"#2D4A3E",padding:"2px 8px",borderRadius:20,fontWeight:600}}>📄 Seizoen uit PriceLabs</span>
                            :<span style={{fontSize:10,background:"#F7F4EF",color:"#888",padding:"2px 8px",borderRadius:20}}>📊 Belgische kust defaults</span>
                          }
                        </div>
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={yr1} margin={{top:0,right:8,left:0,bottom:0}} barCategoryGap="30%">
                            <CartesianGrid strokeDasharray="3 3" stroke="#EDE8E0" vertical={false} />
                            <XAxis dataKey="maand" tick={{fontSize:10,fill:"#BBB"}} axisLine={false} tickLine={false} />
                            <YAxis tick={{fontSize:10,fill:"#BBB"}} tickFormatter={v=>`€${(v/1000).toFixed(0)}k`} axisLine={false} tickLine={false} width={36} />
                            <Tooltip content={<Tip/>} />
                            <Bar dataKey="omzet" radius={[5,5,0,0]}>
                              {yr1.map((e,i)=><Cell key={i} fill={faseColors[e.fase]}/>)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <div style={{display:"flex",gap:16,marginTop:12,flexWrap:"wrap"}}>
                          {[1,2,3].map(f=>(
                            <div key={f} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#666"}}>
                              <div style={{width:10,height:10,borderRadius:2,background:faseColors[f]}}/>
                              <span>Fase {f} — {faseLabels[f]}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {yr2.length>0&&(
                        <div style={{background:"white",borderRadius:12,padding:"20px 16px 12px"}}>
                          <div style={{fontSize:12,color:"#999",marginBottom:14}}>Jaar 2 kwartaalprognose — na opgebouwde reviews & optimalisatie</div>
                          <ResponsiveContainer width="100%" height={160}>
                            <AreaChart data={yr2} margin={{top:0,right:8,left:0,bottom:0}}>
                              <defs>
                                <linearGradient id="yr2grad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#C8952A" stopOpacity={0.25}/>
                                  <stop offset="95%" stopColor="#C8952A" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="#EDE8E0" vertical={false}/>
                              <XAxis dataKey="label" tick={{fontSize:10,fill:"#BBB"}} axisLine={false} tickLine={false}/>
                              <YAxis tick={{fontSize:10,fill:"#BBB"}} tickFormatter={v=>`€${(v/1000).toFixed(0)}k`} axisLine={false} tickLine={false} width={36}/>
                              <Tooltip content={<Tip/>}/>
                              <Area type="monotone" dataKey="omzet" stroke="#C8952A" strokeWidth={2.5} fill="url(#yr2grad)" dot={{fill:"#C8952A",r:4}}/>
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* AFREKENING & GELDSTROMEN */}
                {report.scenarios?.optimaal?.bedrag &&
                  parseMonthlyEuroFromBedrag(report.scenarios.optimaal.bedrag) &&
                  (() => {
                    const opt = report.scenarios.optimaal;
                    const monthlyEuro = parseMonthlyEuroFromBedrag(opt.bedrag);
                    const yearlyIncl = monthlyEuro * 12;
                    const yearlyExVat = Math.round(yearlyIncl / 1.12);
                    const btwLogies = yearlyIncl - yearlyExVat;
                    const commJ = Math.max(0, Math.round(Number(fiscJaarComm)) || 0);
                    const schJ = Math.max(0, Math.round(Number(fiscJaarSchoonmaak)) || 0);
                    const linJ = Math.max(0, Math.round(Number(fiscJaarLinnen)) || 0);
                    const comm = splitIncl21(commJ);
                    const sch = splitIncl21(schJ);
                    const lin = splitIncl21(linJ);
                    const neg = (n) => `− ${formatEURInt(n)}`;
                    const totalFactuur = comm.incl + sch.incl + lin.incl;
                    const netA = yearlyIncl - btwLogies - comm.incl - sch.incl - lin.incl;
                    const netB = yearlyIncl - btwLogies - totalFactuur;

                    const serviceRows = (label, s) => (
                      <>
                        <tr>
                          <td>
                            {label}{" "}
                            <span style={{ fontSize: 10, color: "#888" }}>(incl. 21% btw)</span>
                          </td>
                          <td style={{ color: "#8B2E00", textAlign: "right", whiteSpace: "nowrap" }}>{neg(s.incl)}</td>
                        </tr>
                        <tr>
                          <td style={{ paddingLeft: 16, fontSize: 12, color: "#666" }}>waarvan omzet excl. btw</td>
                          <td style={{ color: "#8B2E00", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{neg(s.excl)}</td>
                        </tr>
                        <tr>
                          <td style={{ paddingLeft: 16, fontSize: 12, color: "#666" }}>waarvan btw 21%</td>
                          <td style={{ color: "#8B2E00", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{neg(s.btw)}</td>
                        </tr>
                      </>
                    );

                    return (
                      <div className="report-section">
                        <div className="report-section-title">Afrekening &amp; geldstromen (indicatief)</div>
                        <p className="gids-belasting-sub">
                          Voorbeeld op jaarbasis naar scenario <strong>Optimaal</strong>: logiesomzet met <strong>12% btw</strong>; commissie, schoonmaak en
                          linnen als <strong>21% btw-diensten</strong> (bedragen die u invoert zijn <strong>incl. 21% btw</strong>). Geen juridisch of
                          fiscaal advies — louter ter illustratie van twee geldstroom-varianten. Valideer altijd bij uw boekhouder.
                        </p>
                        <div className="fiscal-adjust-panel no-print">
                          <div className="gids-belasting-table-title" style={{ marginBottom: 12 }}>Invoer (jaarbasis, €)</div>
                          <div className="fiscal-adjust-grid">
                            <div className="fiscal-adjust-field">
                              <label htmlFor="cash-comm">Commissie YourDomi (incl. 21% btw)</label>
                              <input
                                id="cash-comm"
                                type="number"
                                min={0}
                                step={1}
                                value={fiscJaarComm}
                                onChange={(e) => setFiscJaarComm(Math.max(0, parseInt(e.target.value, 10) || 0))}
                              />
                            </div>
                            <div className="fiscal-adjust-field">
                              <label htmlFor="cash-schoon">Schoonmaak (incl. 21% btw)</label>
                              <input
                                id="cash-schoon"
                                type="number"
                                min={0}
                                step={1}
                                value={fiscJaarSchoonmaak}
                                onChange={(e) => setFiscJaarSchoonmaak(Math.max(0, parseInt(e.target.value, 10) || 0))}
                              />
                            </div>
                            <div className="fiscal-adjust-field">
                              <label htmlFor="cash-linnen">Linnen (incl. 21% btw)</label>
                              <input
                                id="cash-linnen"
                                type="number"
                                min={0}
                                step={1}
                                value={fiscJaarLinnen}
                                onChange={(e) => setFiscJaarLinnen(Math.max(0, parseInt(e.target.value, 10) || 0))}
                              />
                            </div>
                          </div>
                          <p className="fiscal-adjust-hint">
                            Bij een ander brochure-pakket kiest u hieronder het tarief — de commissie wordt opnieuw berekend. Schoonmaak en linnen blijven
                            staan tot u een nieuw rapport genereert.
                          </p>
                        </div>
                        <div className="fee-pill-row no-print" style={{ marginBottom: 12 }}>
                          {BROCHURE_FEE_TIERS.map((tier) => (
                            <button
                              key={tier.pct}
                              type="button"
                              className={`fee-pill${brochureFeePct === tier.pct ? " active" : ""}`}
                              onClick={() => setBrochureFeePct(tier.pct)}
                            >
                              <span className="fee-pill-pct">{tier.pct}%</span>
                              <span className="fee-pill-name">{tier.name}</span>
                              <span className="fee-pill-blurb">{tier.blurb}</span>
                            </button>
                          ))}
                        </div>
                        <p className="gids-belasting-sub" style={{ marginBottom: 14 }}>
                          Geselecteerd pakket: <strong>{BROCHURE_FEE_TIERS.find((t) => t.pct === brochureFeePct)?.name || "—"}</strong> ({brochureFeePct}%)
                        </p>
                        <div style={{ marginBottom: 18 }}>
                          <div className="gids-belasting-table-title">Scenario Optimaal — kerngetallen</div>
                          <table className="fee-table">
                            <thead>
                              <tr>
                                <th>Onderdeel</th>
                                <th>Waarde</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td>Bruto omzet / maand</td>
                                <td style={{ fontWeight: 600, color: TEAL_DARK }}>{opt.bedrag}</td>
                              </tr>
                              <tr>
                                <td>Bezetting</td>
                                <td>{opt.bezetting || "—"}</td>
                              </tr>
                              <tr>
                                <td>ADR</td>
                                <td>{opt.adr || "—"}</td>
                              </tr>
                              <tr className="fee-highlight">
                                <td>Jaaromzet logies (12 × maand, incl. 12% btw)</td>
                                <td>{formatEURInt(yearlyIncl)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <div className="cashflow-dual-grid">
                          <div style={{ background: "#FAFAF8", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E2D9" }}>
                            <div className="cashflow-model-title">(A) YourDomi ontvangt en verrekent</div>
                            <table className="fee-table">
                              <thead>
                                <tr>
                                  <th>Post</th>
                                  <th style={{ textAlign: "right" }}>Bedrag</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td>Ontvangsten logies (incl. 12% btw)</td>
                                  <td style={{ textAlign: "right", fontWeight: 600 }}>{formatEURInt(yearlyIncl)}</td>
                                </tr>
                                <tr>
                                  <td style={{ fontSize: 12, color: "#666", paddingLeft: 8 }}>waarvan omzet excl. btw (tarief 12/112)</td>
                                  <td style={{ textAlign: "right", fontSize: 12 }}>{formatEURInt(yearlyExVat)}</td>
                                </tr>
                                <tr>
                                  <td>Btw logies te storten / te reserveren</td>
                                  <td style={{ textAlign: "right", color: "#8B2E00", whiteSpace: "nowrap" }}>{neg(btwLogies)}</td>
                                </tr>
                                {serviceRows("Commissie YourDomi", comm)}
                                {serviceRows("Schoonmaak", sch)}
                                {serviceRows("Linnen", lin)}
                                <tr className="fee-highlight">
                                  <td>
                                    <strong>Netto uitbetaling aan eigenaar</strong>
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <strong>{formatEURInt(netA)}</strong>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div style={{ background: "#FAFAF8", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E2D9" }}>
                            <div className="cashflow-model-title">(B) Eigenaar ontvangt — factuur YourDomi</div>
                            <table className="fee-table">
                              <thead>
                                <tr>
                                  <th>Post</th>
                                  <th style={{ textAlign: "right" }}>Bedrag</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td>Ontvangsten eigenaar (incl. 12% btw)</td>
                                  <td style={{ textAlign: "right", fontWeight: 600 }}>{formatEURInt(yearlyIncl)}</td>
                                </tr>
                                <tr>
                                  <td>Btw logies af te dragen</td>
                                  <td style={{ textAlign: "right", color: "#8B2E00", whiteSpace: "nowrap" }}>{neg(btwLogies)}</td>
                                </tr>
                                {serviceRows("Factuur YourDomi — commissie", comm)}
                                {serviceRows("Factuur YourDomi — schoonmaak", sch)}
                                {serviceRows("Factuur YourDomi — linnen", lin)}
                                <tr>
                                  <td>
                                    <strong>Totaal factuur YourDomi</strong> <span style={{ fontSize: 10, color: "#888" }}>(incl. 21% btw)</span>
                                  </td>
                                  <td style={{ textAlign: "right", color: "#8B2E00", whiteSpace: "nowrap" }}>
                                    <strong>{neg(totalFactuur)}</strong>
                                  </td>
                                </tr>
                                <tr className="fee-highlight">
                                  <td>
                                    <strong>Netto na btw logies &amp; factuur YourDomi</strong>
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <strong>{formatEURInt(netB)}</strong>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                        <div className="gids-warning" style={{ marginTop: 16 }}>
                          <strong>Disclaimer:</strong> Dit is een rekenvoorbeeld op basis van door u aangepaste aannames en scenario Optimaal. Geen vervanging
                          van professioneel boekhoudkundig of fiscaal advies; contractuele en wettelijke regels kunnen afwijken.
                        </div>
                      </div>
                    );
                  })()}

                {/* PRAKTISCHE GIDS — alleen vergunning */}
                {report.praktischeGids?.stappen?.length > 0 && (
                  <div className="report-section" style={{ pageBreakBefore: "always" }}>
                    <div className="report-section-title">Praktische gids — vergunning</div>
                    <div style={{ marginBottom: 28 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: TEAL_DARK, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>📋</span> Stappenplan vergunning &amp; registratie in {report.gemeente}
                      </div>
                      <div style={{ background: "#FAFAF8", borderRadius: 12, padding: "4px 20px", border: "1px solid #E8E2D9" }}>
                        {report.praktischeGids.stappen.map((s, i) => (
                          <div key={i} className="gids-step">
                            <div className="gids-step-num">{s.n}</div>
                            <div className="gids-step-body">
                              <div className="gids-step-title">{s.titel}</div>
                              <div>{s.tekst}</div>
                              {s.contactNaam && (
                                <a
                                  href={s.contactUrl && s.contactUrl.startsWith("http") ? s.contactUrl : "#"}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="gids-contact"
                                >
                                  🔗 {s.contactNaam}
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Brandveiligheid — vaste pand-checklist + AI (lokale zone) */}
                {(() => {
                  const punten = buildPandBrandveiligheidPunten(report);
                  const brandweer = report.praktischeGids?.brandweer;
                  const naVergunning = (report.praktischeGids?.stappen?.length || 0) > 0;
                  return (
                    <div className="report-section" style={naVergunning ? undefined : { pageBreakBefore: "always" }}>
                      <div className="report-section-title">Brandveiligheid — toegepast op dit pand</div>
                      <p className="gids-belasting-sub">
                        Onderstaande punten zijn afgeleid van <strong>uw formulier</strong> (adres, type, slaapkamers en slaapplaatsen). Daaronder volgt wat de
                        AI opzoekt bij de brandweerzone{report.gemeente ? ` in ${report.gemeente}` : ""} — combineer beide met een lokaal gesprek.
                      </p>
                      <div style={{ background: "#FAFAF8", borderRadius: 12, padding: "16px 20px", border: "1px solid #E8E2D9", marginBottom: brandweer?.length ? 20 : 0 }}>
                        <div className="gids-belasting-table-title" style={{ marginBottom: 10 }}>
                          Uw pand in dit rapport
                        </div>
                        <ul className="gids-belasting-list" style={{ marginBottom: 0 }}>
                          {punten.map((line, i) => (
                            <li key={i}>{lineToBoldSpans(line)}</li>
                          ))}
                        </ul>
                      </div>
                      {brandweer?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: TEAL_DARK, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 16 }}>🔥</span> Aanvulling — brandweerzone &amp; bronnen{report.gemeente ? ` (${report.gemeente})` : ""}
                          </div>
                          <div style={{ background: "#FAFAF8", borderRadius: 12, padding: "4px 20px", border: "1px solid #E8E2D9" }}>
                            {brandweer.map((item, i) => (
                              <div key={i} className="gids-step">
                                <div className="gids-step-num" style={{ background: "#C05A2A" }}>
                                  🔒
                                </div>
                                <div className="gids-step-body">
                                  <div className="gids-step-title">{item.titel}</div>
                                  <div>{item.tekst}</div>
                                  {item.contactNaam && (
                                    <a
                                      href={item.contactUrl && item.contactUrl.startsWith("http") ? item.contactUrl : "#"}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="gids-contact"
                                      style={{ marginTop: 6 }}
                                    >
                                      📞 {item.contactNaam}
                                    </a>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* AI TEXT BODY */}
                <ReportBodyHtml html={report.html} />

                <div className="disclaimer">
                  ⚠️ Dit rapport is een indicatieve analyse op basis van marktdata en AI-modellen. Omzetcijfers zijn schattingen en geen garanties. YourDomi is niet aansprakelijk voor beslissingen genomen op basis van dit rapport.
                </div>

                <div className="report-footer">
                  <span>yourdomi.be</span>
                  <span>Vertrouwelijk — opgesteld voor {report.address}</span>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
