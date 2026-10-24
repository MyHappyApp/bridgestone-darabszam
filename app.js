"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const SUPABASE_URL = "https://vruxgyagbikurrrkuvzn.supabase.co";
  const SUPABASE_KEY = "sb_publishable_s1tl9vzVsr5qT21Tdhtrog_289qouye";

  let client;
  let user = null;
  let entries = new Map();
  let month = new Date();
  month = new Date(month.getFullYear(), month.getMonth(), 1);

  let registerMode = false;
  let adjusted = false;
  let loaded = false;
  let saving = false;
  let selectedDate = "";
  let initialEntrySnapshot = "";
  let loadVersion = 0;

  const numberFormat = new Intl.NumberFormat("hu-HU");
  const monthFormat = new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "long"
  });
  const dayFormat = new Intl.DateTimeFormat("hu-HU", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  });

  function readPreference(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A napló ettől még menthető a Supabase-be.
    }
  }

  function preferenceKey(name) {
    return `darabszam:${user?.id ?? "guest"}:${name}`;
  }

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDate(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function rounded(value) {
    // Fél darabnál a negatív értéket is a nullától távolabb kerekítjük.
    const result = Math.sign(value) * Math.round(Math.abs(value));
    return Object.is(result, -0) ? 0 : result;
  }

  function signed(value) {
    const n = rounded(value);
    return `${n > 0 ? "+" : ""}${numberFormat.format(n)}`;
  }

  function paintBalance(element, value, suffix = "") {
    if (value == null) { element.textContent = "—"; element.classList.remove("positive", "negative", "neutral"); return; }
    element.textContent = signed(value) + suffix;
    element.classList.remove("positive", "negative", "neutral");
    const n = rounded(value);
    element.classList.add(
      n > 0 ? "positive" : n < 0 ? "negative" : "neutral"
    );
  }

  function balance(entry) {
    if (entry.actual_count == null || entry.planned_count == null) return null;
    const raw = entry.actual_count - entry.planned_count;
    return adjusted
      ? entry.actual_count - (entry.planned_count - entry.planned_count * entry.downtime_minutes / 720)
      : raw;
  }

  function duration(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours} ó ${rest} p`;
  }

  function message(id, text = "", isError = false) {
    const element = $(id);
    element.textContent = text;
    element.classList.toggle("error", isError);
  }

  function errorText(error) {
    const code = error?.code;
    const text = error?.message || "";

    if (code === "invalid_credentials") {
      return "Hibás e-mail-cím vagy jelszó.";
    }
    if (code === "email_not_confirmed") {
      return "Az e-mail-cím még nincs megerősítve. Nyisd meg a regisztrációkor kapott megerősítő linket.";
    }
    if (code === "user_already_exists" || code === "email_exists") {
      return "Ezzel az e-mail-címmel már van fiók. Válaszd a Bejelentkezést.";
    }
    if (code === "weak_password") {
      return "A jelszó nem felel meg a követelményeknek. Legalább 6 karaktert adj meg.";
    }
    if (code === "signup_disabled") {
      return "A regisztráció jelenleg nincs engedélyezve.";
    }
    if (error?.status === 429) {
      return "Túl sok próbálkozás történt. Kérlek, próbáld meg később.";
    }
    if (/fetch|network|timeout|abort/i.test(text)) {
      return "Kapcsolati hiba. Ellenőrizd az internetet, majd próbáld újra.";
    }
    return text
      ? `Nem sikerült a művelet: ${text}`
      : "Nem sikerült a művelet. Próbáld újra.";
  }

  function setAuthMode(isRegister) {
    registerMode = isRegister;
    $("login-tab").classList.toggle("active", !isRegister);
    $("register-tab").classList.toggle("active", isRegister);
    $("password-confirm-group").hidden = !isRegister;
    $("password-confirm").required = isRegister;
    $("password-confirm").disabled = !isRegister;
    $("password").autocomplete = isRegister
      ? "new-password"
      : "current-password";
    $("auth-submit").textContent = isRegister
      ? "Fiók létrehozása"
      : "Bejelentkezés";
    message("auth-message");
  }

  $("login-tab").addEventListener("click", () => setAuthMode(false));
  $("register-tab").addEventListener("click", () => setAuthMode(true));
  setAuthMode(false);

  function showRecoveryRequest(show) {
    $("recovery-request-form").hidden = !show;
    $("auth-form").hidden = show;
    $("auth-section").querySelector(".auth-tabs").hidden = show;
    $("forgot-password").hidden = show;
    $("google-login-area").hidden = show;
    if (show) {
      $("recovery-email").value = $("email").value.trim();
      message("recovery-request-message");
    }
  }

  $("google-login-button").addEventListener("click", async () => {
    if (!client) {
      message("auth-message", "A bejelentkezési rendszer még nem töltődött be. Frissítsd az oldalt.", true);
      return;
    }
    const button = $("google-login-button");
    button.disabled = true;
    message("auth-message", "Átirányítás a Google bejelentkezéshez…");
    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo }
      });
      if (error) throw error;
      setTimeout(() => { button.disabled = false; }, 8000);
    } catch (error) {
      message("auth-message", errorText(error), true);
      button.disabled = false;
    }
  });

  $("forgot-password").addEventListener("click", () => showRecoveryRequest(true));
  $("cancel-recovery").addEventListener("click", () => showRecoveryRequest(false));

  $("recovery-request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) return;
    const button = $("send-recovery");
    button.disabled = true;
    message("recovery-request-message", "Helyreállító e-mail küldése…");
    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await client.auth.resetPasswordForEmail(
        $("recovery-email").value.trim(), { redirectTo }
      );
      if (error) throw error;
      message("recovery-request-message", "Ha ehhez az e-mail-címhez tartozik fiók, elküldtük a jelszó-visszaállító linket. Nézd meg a levélszemét mappát is.");
    } catch (error) {
      message("recovery-request-message", errorText(error), true);
    } finally {
      button.disabled = false;
    }
  });

  $("new-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) return;
    if ($("new-password").value !== $("new-password-confirm").value) {
      message("new-password-message", "A két jelszó nem egyezik.", true);
      return;
    }
    const button = $("update-password");
    button.disabled = true;
    message("new-password-message", "Új jelszó mentése…");
    try {
      const { error } = await client.auth.updateUser({ password: $("new-password").value });
      if (error) throw error;
      $("new-password").value = "";
      $("new-password-confirm").value = "";
      $("new-password-dialog").close();
      message("new-password-message");
      showRecoveryRequest(false);
      // A visszaállításkor létrejött munkamenetből biztonságosan kijelentkeztetjük.
      // Az új jelszóval külön be lehet lépni.
      const { error: signOutError } = await client.auth.signOut({ scope: "local" });
      if (signOutError) throw signOutError;
      applySession(null);
      message("auth-message", "A jelszavad megváltozott. Most már beléphetsz az új jelszóval.");
    } catch (error) {
      message("new-password-message", errorText(error), true);
    } finally {
      button.disabled = false;
    }
  });

  const WARNING = "Ne feledd, ez csak a mi kis saját nyilvántartásunk. Az anyaghiánnyal korrigált érték becslés, nem a munkáltató hivatalos elszámolása.";
  let reportMonth = new Date(month);
  let reportEntries = [];
  let reportReady = false;
  let reportRequest = 0;

  function monthlySummary(rows) {
    const complete = rows.filter(r => r.planned_count != null && r.actual_count != null);
    const plan = complete.reduce((sum, row) => sum + row.planned_count, 0);
    const actual = complete.reduce((sum, row) => sum + row.actual_count, 0);
    const downtime = rows.reduce((sum, row) => sum + (row.downtime_minutes ?? 0), 0);
    const completeDowntime = complete.reduce((sum, row) => sum + (row.downtime_minutes ?? 0), 0);
    const base = complete.length ? actual - plan : null;
    const reducedPlan = complete.length ? plan * (1 - completeDowntime / (complete.length * 720)) : 0;
    return {plan, actual, downtime, base, corrected: complete.length ? actual - reducedPlan : null};
  }
  const countText = n => n == null ? "—" : numberFormat.format(n);
  const balanceText = n => n == null ? "—" : signed(n);
  function hasCounts(row) { return row.planned_count != null && row.actual_count != null; }

  function reportFilename(ext) {
    return `darabszam-${reportMonth.getFullYear()}-${String(reportMonth.getMonth()+1).padStart(2,"0")}.${ext}`;
  }
  function reportData() {
    return [...reportEntries].sort((a,b) => a.work_date.localeCompare(b.work_date));
  }
  function reportDisplay() {
    $("report-month-title").textContent = monthFormat.format(reportMonth);
    const body = $("report-rows");
    const foot = $("report-totals");
    body.replaceChildren(); foot.replaceChildren();
    if (!reportReady) {
      $("report-base").textContent = "—";
      $("report-adjusted").textContent = "—";
      return;
    }
    const rows = reportData();
    const fmt = n => numberFormat.format(n);
    for (const row of rows) {
      const tr = document.createElement("tr");
      const cells = [row.work_date.slice(5).replace("-","." )+".", countText(row.planned_count),countText(row.actual_count),balanceText(hasCounts(row) ? row.actual_count-row.planned_count : null),duration(row.downtime_minutes ?? 0)];
      cells.forEach((value,index) => { const td=document.createElement("td");td.textContent=value;if(index===3) td.className=(row.actual_count-row.planned_count)>0?"positive":(row.actual_count-row.planned_count)<0?"negative":"neutral";tr.append(td);});
      body.append(tr);
    }
    if (!rows.length) { const tr=document.createElement("tr"); const td=document.createElement("td");td.colSpan=5;td.textContent="Ebben a hónapban még nincs bejegyzés.";tr.append(td);body.append(tr); }
    const summary=monthlySummary(rows);
    const tr=document.createElement("tr");
    ["ÖSSZESEN",fmt(summary.plan),fmt(summary.actual),balanceText(summary.base),duration(summary.downtime)].forEach((value,index)=>{const td=document.createElement("td");td.textContent=value;if(index===3)td.className=summary.base>0?"positive":summary.base<0?"negative":"neutral";tr.append(td);});
    foot.append(tr);
    paintBalance($("report-base"),summary.base," db");
    paintBalance($("report-adjusted"),summary.corrected," db");
  }
  async function loadReport() {
    if (!user) return;
    const version=++reportRequest;
    const owner=user.id;
    reportReady=false;
    $("report-status").textContent="Havi adatok betöltése…";
    reportDisplay();
    try {
      const start=dateKey(reportMonth);
      const end=dateKey(new Date(reportMonth.getFullYear(),reportMonth.getMonth()+1,1));
      const {data,error}=await client.from("daily_entries")
        .select("work_date,planned_count,actual_count,downtime_minutes")
        .eq("user_id",owner).gte("work_date",start).lt("work_date",end).order("work_date");
      if(version!==reportRequest||user?.id!==owner) return;
      if(error)throw error;
      reportEntries=data;
      reportReady=true;
      $("report-status").textContent="";
      reportDisplay();
    } catch(error) {
      if(version!==reportRequest)return;
      $("report-status").textContent=errorText(error);
    }
  }
  function csvCell(value) {return `"${String(value).replace(/"/g,'""')}"`;}
  function downloadBlob(blob,filename) {
    const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function makeCsv() {
    const rows=reportData(),s=monthlySummary(rows);
    const lines=[["Dátum","Terv","Lehozott","Egyenleg","Anyaghiány (perc)"]];
    rows.forEach(r=>lines.push([r.work_date,r.planned_count,r.actual_count,hasCounts(r) ? r.actual_count-r.planned_count : "",r.downtime_minutes]));
    lines.push(["ÖSSZESEN",s.plan,s.actual,s.base,s.downtime]);
    lines.push([],["Alap darabszám-egyenleg",balanceText(s.base)],["Anyaghiány figyelembevételével számolt egyenleg",balanceText(s.corrected)],[],[WARNING]);
    return "\uFEFF"+lines.map(row=>row.map(csvCell).join(";")).join("\r\n");
  }
  function pdfDefinition() {
    const rows=reportData(),s=monthlySummary(rows);
    const table=[["Dátum","Terv","Lehozott","Egyenleg","Anyaghiány"]];
    rows.forEach(r=>table.push([r.work_date.slice(5).replace("-",".")+".",countText(r.planned_count),countText(r.actual_count),balanceText(hasCounts(r) ? r.actual_count-r.planned_count : null),duration(r.downtime_minutes ?? 0)]));
    table.push([{text:"ÖSSZESEN",bold:true},{text:String(s.plan),bold:true},{text:String(s.actual),bold:true},{text:balanceText(s.base),bold:true},{text:duration(s.downtime),bold:true}]);
    return {pageSize:"A4",pageMargins:[26,35,26,35],content:[
      {text:"HAVI DARABSZÁM-ÖSSZESÍTŐ",fontSize:17,bold:true,color:"#123c8c",margin:[0,0,0,5]},
      {text:monthFormat.format(reportMonth),fontSize:12,margin:[0,0,0,18]},
      {table:{headerRows:1,widths:["auto","*","*","*","auto"],body:table},layout:"lightHorizontalLines",fontSize:9},
      {text:"Alap darabszám-egyenleg: "+balanceText(s.base)+" db",bold:true,fontSize:13,margin:[0,20,0,8]},
      {text:"Anyaghiány figyelembevételével számolt egyenleg: "+balanceText(s.corrected)+" db",bold:true,fontSize:12,margin:[0,0,0,20]},
      {text:WARNING,color:"#505d73",fontSize:9}
    ],defaultStyle:{font:"Roboto"}};
  }
  async function pdfBlob() {
    if(!window.pdfMake)throw new Error("A PDF-készítő nem töltődött be. Ellenőrizd az internetkapcsolatot.");
    return await new Promise((resolve,reject)=>{try{window.pdfMake.createPdf(pdfDefinition()).getBlob(resolve);}catch(e){reject(e);}});
  }
  async function shareFile(file) {
    if(navigator.canShare?.({files:[file]}) && navigator.share) {
      await navigator.share({files:[file],title:"Havi darabszám-összesítő"});
    } else {downloadBlob(file,file.name);$("report-status").textContent="A készülék nem támogatja a fájl közvetlen megosztását. A PDF-et letöltöttük, innen továbbküldheted.";}
  }
  function mail(subject,body) {
    window.location.href=`mailto:myhapyapp@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function render() {
    $("calendar-title").textContent = monthFormat.format(month);

    $("raw-mode").classList.toggle("active", !adjusted);
    $("adjusted-mode").classList.toggle("active", adjusted);
    $("raw-mode").setAttribute("aria-pressed", String(!adjusted));
    $("adjusted-mode").setAttribute("aria-pressed", String(adjusted));


    if (loaded) {
      const rows = [...entries.values()];
      const total = adjusted ? monthlySummary(rows).corrected : monthlySummary(rows).base;

      paintBalance($("monthly-balance"), total, " db");
      $("recorded-days").textContent = rows.length;
      $("total-planned").textContent = numberFormat.format(
        rows.reduce((sum, row) => sum + (row.planned_count ?? 0), 0)
      );
      $("total-actual").textContent = numberFormat.format(
        rows.reduce((sum, row) => sum + (row.actual_count ?? 0), 0)
      );
      $("total-downtime").textContent = duration(
        rows.reduce((sum, row) => sum + (row.downtime_minutes ?? 0), 0)
      );
    } else {
      $("monthly-balance").textContent = "—";
      $("monthly-balance").classList.remove("positive", "negative");
      for (const id of [
        "recorded-days", "total-planned", "total-actual", "total-downtime"
      ]) {
        $(id).textContent = "—";
      }
    }

    renderCalendar();
    if ($("entry-dialog").open) updatePreview();
  }

  function renderCalendar() {
    const grid = $("calendar-grid");
    grid.replaceChildren();

    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const offset = (month.getDay() + 6) % 7;
    const days = new Date(year, monthIndex + 1, 0).getDate();
    const today = dateKey(new Date());

    for (let i = 0; i < offset; i++) {
      const empty = document.createElement("div");
      empty.className = "calendar-empty";
      empty.setAttribute("aria-hidden", "true");
      grid.append(empty);
    }

    for (let day = 1; day <= days; day++) {
      const date = new Date(year, monthIndex, day);
      const key = dateKey(date);
      const entry = entries.get(key);
      const button = document.createElement("button");

      button.type = "button";
      button.className = "calendar-day";
      button.disabled = !loaded || saving;
      button.classList.toggle("today", key === today);
      button.classList.toggle("weekend", [0, 6].includes(date.getDay()));
      button.classList.toggle("has-entry", Boolean(entry));

      if (key === today) button.setAttribute("aria-current", "date");

      const dayNumber = document.createElement("span");
      dayNumber.className = "day-number";
      dayNumber.textContent = day;

      const dayBalance = document.createElement("span");
      dayBalance.className = "day-balance";

      if (entry && loaded) {
        paintBalance(dayBalance, balance(entry));
      } else {
        dayBalance.textContent = loaded ? "·" : "—";
      }

      button.setAttribute(
        "aria-label",
        `${dayFormat.format(date)}. ${
          !loaded
            ? "Adatok még nincsenek betöltve."
            : entry
              ? balance(entry) == null ? "Félkész bejegyzés." : `${adjusted ? "Becsült" : "Nyers"} egyenleg: ${signed(balance(entry))} darab.`
              : "Nincs bejegyzés."
        }`
      );

      button.append(dayNumber, dayBalance);
      if (entry && !hasCounts(entry)) {
        button.classList.add("incomplete-entry");
        const badge = document.createElement("span");
        badge.className = "incomplete-label";
        badge.textContent = "Félkész";
        button.append(badge);
      }
      button.addEventListener("click", () => openEntry(key));
      grid.append(button);
    }
  }

  async function loadMonth() {
    if (!user) return;

    const version = ++loadVersion;
    const owner = user.id;
    const start = dateKey(month);
    const end = dateKey(
      new Date(month.getFullYear(), month.getMonth() + 1, 1)
    );

    loaded = false;
    entries.clear();
    render();
    message("status-message", "Napló betöltése…");

    try {
      const { data, error } = await client
        .from("daily_entries")
        .select("user_id,work_date,planned_count,actual_count,downtime_minutes,downtime_items,note")
        .eq("user_id", owner)
        .gte("work_date", start)
        .lt("work_date", end)
        .order("work_date");

      if (version !== loadVersion || user?.id !== owner) return;
      if (error) throw error;

      entries = new Map(data.map((row) => [row.work_date, row]));
      loaded = true;
      message("status-message");
      render();
    } catch (error) {
      if (version !== loadVersion || user?.id !== owner) return;
      message(
        "status-message",
        `${errorText(error)} Az újrapróbáláshoz kattints a Mai nap gombra.`,
        true
      );
    }
  }

  function changeMonth(amount) {
    if (saving) return;
    month = new Date(month.getFullYear(), month.getMonth() + amount, 1);
    void loadMonth();
  }

  $("previous-month").addEventListener("click", () => changeMonth(-1));
  $("next-month").addEventListener("click", () => changeMonth(1));

  $("today-button").addEventListener("click", async () => {
  if (saving || !user) return;

  const now = new Date();
  const today = dateKey(now);

  const currentMonth =
    month.getFullYear() === now.getFullYear() &&
    month.getMonth() === now.getMonth();

  if (!currentMonth || !loaded) {
    month = new Date(now.getFullYear(), now.getMonth(), 1);
    await loadMonth();
  }

  if (loaded) {
    openEntry(today);
  }

  });

  function setMode(value) {
    adjusted = value;
    savePreference(preferenceKey("adjusted"), String(value));
    render();
  }

  $("raw-mode").addEventListener("click", () => setMode(false));
  $("adjusted-mode").addEventListener("click", () => setMode(true));

  // PWA telepítés: az automatikus telepítési ablakot csak a támogatott böngészők adják.
  let pendingInstallPrompt = null;
  const installButton = $("install-app-button");
  const installMessage = $("install-app-message");
  const isInstalled = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  function updateInstallUI() {
    if (isInstalled()) {
      installButton.hidden = true;
      installMessage.textContent = "Az alkalmazás már telepítve van, és önálló ablakban fut.";
    } else {
      installButton.hidden = false;
      installMessage.textContent = pendingInstallPrompt ? "Készen áll a telepítésre." : "Ha nem jelenik meg telepítési ablak, Androidon a böngésző menüjében válaszd a Telepítés / Hozzáadás a kezdőképernyőhöz lehetőséget. iPhone-on Safariban: Megosztás → Főképernyőhöz adás.";
    }
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingInstallPrompt = event;
    updateInstallUI();
  });
  window.addEventListener("appinstalled", () => {
    pendingInstallPrompt = null;
    updateInstallUI();
  });
  installButton.addEventListener("click", async () => {
    if (!pendingInstallPrompt) { updateInstallUI(); return; }
    const prompt = pendingInstallPrompt;
    pendingInstallPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installMessage.textContent = choice?.outcome === "accepted" ? "A telepítés elindult." : "A telepítést most nem választottad.";
    } catch {
      installMessage.textContent = "A telepítés most nem indítható. Próbáld meg a böngésző menüjéből.";
    }
  });
  updateInstallUI();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // A napló online módban szervizmunkás nélkül is működik.
      });
    });
  }

  $("settings-button").addEventListener("click", () => $("settings-dialog").showModal());
  $("close-settings").addEventListener("click", () => $("settings-dialog").close());

  $("report-button").addEventListener("click",()=>{
    $("settings-dialog").close();reportMonth=new Date(month);$("report-dialog").showModal();void loadReport();
  });
  $("close-report").addEventListener("click",()=>$("report-dialog").close());
  $("report-prev").addEventListener("click",()=>{reportMonth=new Date(reportMonth.getFullYear(),reportMonth.getMonth()-1,1);void loadReport();});
  $("report-next").addEventListener("click",()=>{reportMonth=new Date(reportMonth.getFullYear(),reportMonth.getMonth()+1,1);void loadReport();});
  $("report-csv").addEventListener("click",()=>{if(reportReady)downloadBlob(new Blob([makeCsv()],{type:"text/csv;charset=utf-8"}),reportFilename("csv"));});
  $("report-pdf").addEventListener("click",async()=>{if(!reportReady)return;try{$("report-status").textContent="PDF készítése…";const blob=await pdfBlob();downloadBlob(blob,reportFilename("pdf"));$("report-status").textContent="PDF letöltve.";}catch(e){$("report-status").textContent=e.message;}});
  $("report-share").addEventListener("click",async()=>{if(!reportReady)return;try{$("report-status").textContent="PDF készítése…";const blob=await pdfBlob();await shareFile(new File([blob],reportFilename("pdf"),{type:"application/pdf"}));}catch(e){$("report-status").textContent=e.name==="AbortError"?"Megosztás megszakítva.":e.message;}});
  $("share-app-button").addEventListener("click",async()=>{const url=location.href;try{if(navigator.share)await navigator.share({title:"Darabszám – Műszaknapló",url});else {await navigator.clipboard.writeText(url);message("status-message","Az alkalmazás linkje a vágólapra másolva.");$("settings-dialog").close();}}catch(e){if(e.name!=="AbortError")message("status-message","A link megosztása nem sikerült.",true);}});
  $("suggestion-button").addEventListener("click",()=>mail("Darabszám napló – Ötlet, javaslat","Szia!\n\nAz alábbi ötletem van:\n\n"));
  $("bug-button").addEventListener("click",()=>mail("Darabszám napló – Hibajelentés","Szia!\n\nA következő hibát tapasztaltam:\n\nEszköz / böngésző:\n"));
  $("privacy-button").addEventListener("click",()=>{$("settings-dialog").close();$("privacy-dialog").showModal();});
  $("close-privacy").addEventListener("click",()=>$("privacy-dialog").close());

  function downtimeRows() { return [...$("downtime-list").querySelectorAll(".downtime-row")]; }
  function addDowntimeRow(item = {hours: "", minutes: "", material: ""}) {
    const row = document.createElement("div"); row.className = "downtime-row";
    row.innerHTML = `<label>Óra<input class="dt-hours" type="number" inputmode="numeric" min="0" max="12" step="1"></label><label>Perc<input class="dt-minutes" type="number" inputmode="numeric" min="0" max="720" step="1"></label><label class="dt-material-label">Anyag neve<input class="dt-material" type="text" maxlength="120" placeholder="Anyag neve"></label><button class="remove-downtime" type="button" aria-label="Sor törlése" title="Sor törlése">×</button>`;
    row.querySelector(".dt-hours").value = item.hours || "";
    row.querySelector(".dt-minutes").value = item.minutes || "";
    row.querySelector(".dt-material").value = item.material ?? "";
    row.querySelector(".remove-downtime").addEventListener("click", () => {row.remove();updatePreview();});
    $("downtime-list").append(row); updatePreview();
  }
  $("add-downtime").addEventListener("click", () => addDowntimeRow());
  function downtimeValues() {
    let total = 0, valid = true;
    const items = downtimeRows().map(row => {
      const hoursInput = row.querySelector(".dt-hours");
      const minutesInput = row.querySelector(".dt-minutes");
      const h = hoursInput.value.trim() === "" ? 0 : hoursInput.valueAsNumber;
      const m = minutesInput.value.trim() === "" ? 0 : minutesInput.valueAsNumber;
      const material = row.querySelector(".dt-material").value.trim();
      if (!Number.isInteger(h) || h < 0 || h > 12 || !Number.isInteger(m) || m < 0 || m > 720) valid = false;
      const minutes = h * 60 + m;
      if (Number.isFinite(minutes)) total += minutes;
      return {minutes, material};
    }).filter(item => item.minutes > 0 || item.material);
    if (total > 720) valid = false;
    return {items, total, valid};
  }
  function openEntry(key) {
    if (!loaded || saving || !user) return;
    selectedDate = key;
    const entry = entries.get(key);
    $("entry-title").textContent = dayFormat.format(parseDate(key));
    $("planned-count").value = entry?.planned_count ?? "";
    $("actual-count").value = entry?.actual_count ?? "";
    $("downtime-list").replaceChildren();
    const items = entry?.downtime_items;
    if (Array.isArray(items) && items.length) {
      items.forEach(item => addDowntimeRow({hours: 0, minutes: item.minutes, material: item.material}));
    } else if ((entry?.downtime_minutes ?? 0) > 0) {
      addDowntimeRow({hours: 0, minutes: entry.downtime_minutes, material: ""});
    }
    $("delete-entry").hidden = !entry;
    $("day-note").value = entry?.note ?? "";
    message("entry-message");updatePreview();
    initialEntrySnapshot = entrySnapshot();
    $("entry-dialog").showModal();
  }
  function entrySnapshot() {
    return JSON.stringify([$("planned-count").value,$("actual-count").value,$("day-note").value,
      ...downtimeRows().map(row => [row.querySelector(".dt-hours").value,row.querySelector(".dt-minutes").value,row.querySelector(".dt-material").value])]);
  }
  function formEntry() {
    const parseCount = id => $(id).value.trim() === "" ? null : $(id).valueAsNumber;
    const planned = parseCount("planned-count"), actual = parseCount("actual-count");
    const validCount = n => n === null || (Number.isInteger(n) && n >= 0 && n <= 2147483647);
    const downtime = downtimeValues();
    if (!validCount(planned) || !validCount(actual) || !downtime.valid) return null;
    return {planned_count:planned,actual_count:actual,downtime_minutes:downtime.total,
      downtime_items:downtime.items,note:$("day-note").value.trim()};
  }
  function updatePreview() {
    const downtime = downtimeValues();
    const rows = downtimeRows();
    $("downtime-total").hidden = rows.length < 2;
    $("downtime-total-value").textContent = duration(downtime.total);
    rows.forEach(row => row.querySelector(".dt-hours").setCustomValidity(""));
    if (!downtime.valid && rows.length) rows[0].querySelector(".dt-hours").setCustomValidity("Az állásidő összesen legfeljebb 12 óra lehet. Ellenőrizd az időket.");
    $("daily-mode-label").textContent = adjusted ? "Napi egyenleg – Becsült érték" : "Napi egyenleg – Alap";
    const entry = formEntry();
    paintBalance($("daily-balance"),entry ? balance(entry) : null," db");
  }
  $("entry-form").addEventListener("input", updatePreview);

  function closeEntrySafely() {
    if (saving) return;
    if (entrySnapshot() !== initialEntrySnapshot &&
        !window.confirm("A módosításokat még nem mentetted el. Biztosan kilépsz mentés nélkül?")) return;
    $("entry-dialog").close();
  }

  $("close-dialog").addEventListener("click", closeEntrySafely);

  $("entry-dialog").addEventListener("cancel", (event) => {
    if (saving) { event.preventDefault(); return; }
    if (entrySnapshot() !== initialEntrySnapshot &&
        !window.confirm("A módosításokat még nem mentetted el. Biztosan kilépsz mentés nélkül?")) event.preventDefault();
  });

  function setSaving(value) {
    saving = value;
    for (const id of [
      "planned-count", "actual-count", "add-downtime", "day-note", "save-entry", "delete-entry",
      "close-dialog", "logout-button", "previous-month",
      "next-month", "today-button"
    ]) {
      $(id).disabled = value;
    }
    $("downtime-list").querySelectorAll("input,button").forEach(el => {el.disabled = value;});
    $("save-entry").textContent = value ? "Folyamatban…" : "Mentés";
  }

  $("entry-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !user) return;

    updatePreview();
    if (!$("entry-form").reportValidity()) return;
    const values = formEntry();
    if (!values) {
      message("entry-message", "Ellenőrizd a megadott számokat.", true);
      return;
    }

    const owner = user.id;
    const key = selectedDate;
    setSaving(true);
    message("entry-message", "Mentés…");

    try {
      const { data, error } = await client
        .from("daily_entries")
        .upsert(
          { user_id: owner, work_date: key, ...values },
          { onConflict: "user_id,work_date" }
        )
        .select("user_id,work_date,planned_count,actual_count,downtime_minutes,downtime_items,note")
        .single();

      if (user?.id !== owner) return;
      if (error) throw error;

      // Mentés után visszaolvassuk az adatot az adatbázisból.
      // A szerver válasza önmagában nem elég az ellenőrzéshez.
      const { data: confirmed, error: readError } = await client
        .from("daily_entries")
        .select("user_id,work_date,planned_count,actual_count,downtime_minutes,downtime_items,note")
        .eq("user_id", owner)
        .eq("work_date", key)
        .single();
      if (readError) throw readError;
      if (!confirmed || confirmed.planned_count !== values.planned_count ||
          confirmed.actual_count !== values.actual_count ||
          confirmed.downtime_minutes !== values.downtime_minutes ||
          JSON.stringify((confirmed.downtime_items ?? []).map(i => [i.minutes, i.material])) !== JSON.stringify(values.downtime_items.map(i => [i.minutes, i.material])) ||
          (confirmed.note ?? "") !== values.note) {
        throw new Error("A mentett adatok visszaellenőrzése nem sikerült. Az adatlapot nyitva hagytuk.");
      }
      entries.set(key, confirmed);
      initialEntrySnapshot = entrySnapshot();
      if ($("report-dialog").open) void loadReport();
      $("entry-dialog").close();
      message("status-message");
    } catch (error) {
      if (user?.id === owner) {
        message("entry-message", errorText(error), true);
      }
    } finally {
      setSaving(false);
      render();
    }
  });

  $("delete-entry").addEventListener("click", async () => {
    if (saving || !user || !entries.has(selectedDate)) return;
    if (!window.confirm("Biztosan törlöd ennek a napnak a bejegyzését?")) {
      return;
    }

    const owner = user.id;
    const key = selectedDate;
    setSaving(true);
    message("entry-message", "Törlés…");

    try {
      const { data, error } = await client
        .from("daily_entries")
        .delete()
        .eq("user_id", owner)
        .eq("work_date", key)
        .select("work_date");

      if (user?.id !== owner) return;
      if (error) throw error;
      if (!data.length) {
        throw new Error("A bejegyzés nem található. Frissítsd az oldalt.");
      }

      entries.delete(key);
      if ($("report-dialog").open) void loadReport();
      $("entry-dialog").close();
      message("status-message");
    } catch (error) {
      if (user?.id === owner) {
        message("entry-message", errorText(error), true);
      }
    } finally {
      setSaving(false);
      render();
    }
  });

  function applySession(session) {
    const nextUser = session?.user ?? null;
    const changed = nextUser?.id !== user?.id;

    user = nextUser;
    $("auth-section").hidden = Boolean(user);
    $("app-section").hidden = !user;

    if (!user) {
      ++loadVersion;
      entries.clear();
      loaded = false;
      $("account-email").textContent = "";
      $("entry-dialog").close();
      $("report-dialog").close();
      $("privacy-dialog").close();
      $("settings-dialog").close();
      ++reportRequest;
      $("password").value = "";
      $("password-confirm").value = "";
      message("status-message");
      render();
      return;
    }

    $("account-email").textContent = user.email ?? "";

    if (changed) {
      ++loadVersion;
      entries.clear();
      loaded = false;
      $("entry-dialog").close();
      $("report-dialog").close();
      $("privacy-dialog").close();
      $("settings-dialog").close();
      ++reportRequest;
      $("password").value = "";
      $("password-confirm").value = "";

      const now = new Date();
      month = new Date(now.getFullYear(), now.getMonth(), 1);

      adjusted = readPreference(preferenceKey("adjusted"), "false") === "true";

      render();
      message("status-message", "Napló betöltése…");

      // Az adatlekérés az auth esemény feldolgozása után indul.
      setTimeout(() => void loadMonth(), 0);
    }
  }

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client || $("auth-submit").disabled) return;

    if (
      registerMode &&
      $("password").value !== $("password-confirm").value
    ) {
      message("auth-message", "A két jelszó nem egyezik.", true);
      return;
    }

    const isRegister = registerMode;
    const credentials = {
      email: $("email").value.trim(),
      password: $("password").value
    };

    $("auth-submit").disabled = true;
    $("login-tab").disabled = true;
    $("register-tab").disabled = true;
    message("auth-message", isRegister ? "Fiók létrehozása…" : "Belépés…");

    try {
      const { data, error } = isRegister
        ? await client.auth.signUp(credentials)
        : await client.auth.signInWithPassword(credentials);

      if (error) throw error;

      if (data.session) {
        applySession(data.session);
        message("auth-message");
      } else {
        message(
          "auth-message",
          "A regisztráció sikerült! Küldtünk egy megerősítő linket az e-mail-címedre. Kattints rá, és utána jelentkezz be. Ellenőrizd a spam mappát is."
        );
      }
    } catch (error) {
      message("auth-message", errorText(error), true);
    } finally {
      $("auth-submit").disabled = false;
      $("login-tab").disabled = false;
      $("register-tab").disabled = false;
    }
  });

  $("logout-button").addEventListener("click", async () => {
    if (saving) return;
    $("logout-button").disabled = true;

    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      applySession(null);
      $("settings-dialog").close();
      setAuthMode(false);
    } catch (error) {
      message("status-message", errorText(error), true);
    } finally {
      $("logout-button").disabled = false;
    }
  });

  if (!window.supabase) {
    message(
      "status-message",
      "A Supabase betöltése nem sikerült. Ellenőrizd az internetet, majd frissítsd az oldalt.",
      true
    );
    return;
  }

  try {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: {
        fetch: async (url, options = {}) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20000);
          const originalSignal = options.signal;
          const abort = () => controller.abort();

          if (originalSignal?.aborted) controller.abort();
          originalSignal?.addEventListener("abort", abort, { once: true });

          try {
            return await fetch(url, {
              ...options,
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeout);
            originalSignal?.removeEventListener("abort", abort);
          }
        }
      }
    });

    client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        applySession(session);
        message("new-password-message");
        if (!$("new-password-dialog").open) $("new-password-dialog").showModal();
        return;
      }
      applySession(session);
    });
  } catch (error) {
    message("status-message", errorText(error), true);
  }
})();