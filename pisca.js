(() => {
  "use strict";

  const RIV_URL = "https://cdn.jsdelivr.net/gh/negtvozero-jpg/rivs@latest/piscav2.riv";
  const RIVE_RUNTIME_SRC = "https://cdn.jsdelivr.net/npm/@rive-app/webgl2@2.44.2/rive.js";
  const RIVE_WASM_SRC = "https://cdn.jsdelivr.net/npm/@rive-app/webgl2@2.44.2/rive.wasm";
  const ARTBOARD = "Artboard 1";
  const STATE_MACHINE = "State Machine 1";
  const MAX_PENDING_ALERTS = 20;
  const EVENT_GAP_MS = 550;

  const SPECIAL_DURATIONS = {
    1: 4,
    2: 3.5,
    3: 3,
    4: 4,
    5: 5,
    6: 4.5,
    7: 3.5,
    8: 3,
    9: 4,
    10: 5
  };

  const DEFAULTS = {
    bulbCount: 24,
    shapePreset: 1,
    sag: 120,
    arcCount: 3,
    tilt: 0,
    strokeWidth: 4,
    strokeColor: "#37503C",
    idleType: 0,
    idleSpeed: 1,
    animationSpeed: 1,
    color1: "#FF5555",
    color2: "#69DE92",
    color3: "#77B7FF",
    alternateBulbs: false,
    bulbSize: 60,
    bulbSlot1: "0",
    bulbSlot2: "-1",
    bulbSlot3: "-1"
  };

  const RANGES = {
    bulbCount: [5, 37, true],
    shapePreset: [0, 3, true],
    sag: [-200, 200, false],
    arcCount: [0, 5, true],
    tilt: [-900, 900, false],
    strokeWidth: [1, 10, false],
    idleType: [0, 5, true],
    idleSpeed: [0.5, 4, false],
    animationSpeed: [0.5, 4, false],
    bulbSize: [40, 100, false]
  };

  let fields = { ...DEFAULTS };
  let riveInstance = null;
  let mainVM = null;
  let globalVM = null;
  let loadPromise = null;
  let startPromise = null;
  let ready = false;
  let resizeObserver = null;
  let processingAlerts = false;

  const alertQueue = [];
  const canvas = document.getElementById("pisca-canvas");

  function numberField(name) {
    const range = RANGES[name];
    if (!range) return 0;
    const numeric = Number(fields[name]);
    const fallback = Number(DEFAULTS[name]);
    const selected = Number.isFinite(numeric) ? numeric : fallback;
    const value = Math.max(range[0], Math.min(range[1], selected));
    return range[2] ? Math.round(value) : value;
  }

  function booleanField(value) {
    return value === true || value === 1 || value === "true" || value === "1" || value === "on";
  }

  function normalizeHex(value, fallback) {
    const input = String(value || fallback).trim();
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input);
    if (!match) return fallback;
    const hex = match[1];
    if (hex.length === 3) {
      return "#" + hex.split("").map(digit => digit + digit).join("").toUpperCase();
    }
    return "#" + hex.toUpperCase();
  }

  function setNumber(name, value) {
    if (!mainVM) return false;
    const property = mainVM.number(name);
    if (!property) return false;
    property.value = value;
    return true;
  }

  function setBoolean(name, value) {
    if (!mainVM) return false;
    const property = mainVM.boolean(name);
    if (!property) return false;
    property.value = value;
    return true;
  }

  function setColor(name) {
    if (!mainVM) return false;
    const property = mainVM.color(name);
    if (!property) return false;
    const hex = normalizeHex(fields[name], DEFAULTS[name]);
    property.argb(
      255,
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    );
    return true;
  }

  function applyConfig() {
    if (!mainVM) return;
    for (const name of Object.keys(RANGES)) {
      setNumber(name, numberField(name));
    }
    setBoolean("alternateBulbs", booleanField(fields.alternateBulbs));
    setColor("strokeColor");
    setColor("color1");
    setColor("color2");
    setColor("color3");
  }

  function chosenBulbTypes() {
    const slots = [fields.bulbSlot1, fields.bulbSlot2, fields.bulbSlot3];
    const selected = slots
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value >= 0 && value <= 8);
    return selected.length ? selected : [0];
  }

  function applyBulbTypes() {
    if (!globalVM) return false;
    const types = chosenBulbTypes();
    const values = [types[0] ?? 0, types[1] ?? -1, types[2] ?? -1];
    let success = true;
    for (let i = 0; i < 3; i++) {
      const name = "bulbSlot" + (i + 1);
      const property = globalVM.number(name);
      if (!property) {
        console.error("[Pisca V2] Missing LightsGlobal property:", name);
        success = false;
        continue;
      }
      if (property.value !== values[i]) property.value = values[i];
    }
    return success;
  }

  function getAnimationField(name) {
    const value = Number(fields[name]);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 0;
  }

  function animationDuration(mode) {
    const speed = numberField("animationSpeed");
    const duration = SPECIAL_DURATIONS[mode] || 3;
    return Math.round(Math.max(2, Math.min(5, duration / speed)) * 1000);
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function fireAnimation(mode) {
    if (!mainVM || !ready || mode < 1 || mode > 10) return false;
    const type = mainVM.number("animationType");
    const trigger = mainVM.trigger("animationTrigger");
    if (!type || !trigger) return false;
    type.value = mode;
    trigger.trigger();
    return true;
  }

  function enqueueAlert(category) {
    const first = getAnimationField(category + "Animation1");
    const second = getAnimationField(category + "Animation2");
    const sequence = [first, second].filter(mode => mode > 0);
    if (!sequence.length) return;
    if (alertQueue.length >= MAX_PENDING_ALERTS) alertQueue.shift();
    alertQueue.push(sequence);
    processAlertQueue();
  }

  async function processAlertQueue() {
    if (processingAlerts || !ready) return;
    processingAlerts = true;
    try {
      while (ready && alertQueue.length) {
        const sequence = alertQueue.shift();
        for (const mode of sequence) {
          if (!fireAnimation(mode)) break;
          await delay(animationDuration(mode) + 30);
        }
        if (alertQueue.length) await delay(EVENT_GAP_MS);
      }
    } finally {
      processingAlerts = false;
      if (ready && alertQueue.length) processAlertQueue();
    }
  }

  function mapSubscriber(event) {
    if (!event) return "sub";
    if (event.bulkGifted === true) return "giftbomb";
    if (event.isCommunityGift === true || event.playedAsCommunityGift === true) return null;
    if (event.gifted === true || event.isGift === true || event.isGifted === true) return "gift";
    return "sub";
  }

  function eventCategory(listener, event) {
    if (listener === "follower-latest") return "follow";
    if (listener === "subscriber-latest") return mapSubscriber(event);
    if (listener === "tip-latest") return "tip";
    if (listener === "cheer-latest") return "cheer";
    if (listener === "raid-latest") return "raid";
    return null;
  }

  function onEventReceived(object) {
    const detail = object && object.detail;
    if (!detail) return;
    const event = detail.event || {};
    let listener = String(detail.listener || "").toLowerCase();
    if (
      (listener === "event" || listener === "event:test") &&
      typeof event.listener === "string"
    ) {
      listener = event.listener.toLowerCase();
    }
    if (listener === "widget-button") {
      const match = /^test(Follow|Sub|GiftBomb|Gift|Tip|Cheer|Raid)$/.exec(String(event.field || ""));
      if (match) enqueueAlert(match[1].toLowerCase());
      return;
    }
    const category = eventCategory(listener, event);
    if (category) enqueueAlert(category);
  }

  function loadRiveRuntime() {
    if (window["rive"] && window["rive"].Rive) {
      return Promise.resolve(window["rive"]);
    }
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-pisca-rive-runtime="1"]');
      const finish = () => {
        const api = window["rive"];
        if (api && api.Rive) resolve(api);
        else reject(new Error("Rive runtime loaded without the Rive constructor"));
      };
      if (existing) {
        existing.addEventListener("load", finish, { once: true });
        existing.addEventListener("error", () => reject(new Error("Rive runtime failed to load")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = RIVE_RUNTIME_SRC;
      script.async = true;
      script.dataset.piscaRiveRuntime = "1";
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Rive runtime failed to load")), { once: true });
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  function resizeRive() {
    if (riveInstance) riveInstance.resizeDrawingSurfaceToCanvas();
  }

  function bindViewModels() {
    if (!riveInstance) return false;
    mainVM = riveInstance.viewModelInstance;
    if (!mainVM) {
      const definition = riveInstance.viewModelByName("ViewModel1");
      const instance = definition && definition.defaultInstance();
      if (instance) {
        riveInstance.bindViewModelInstance(instance);
        mainVM = riveInstance.viewModelInstance;
      }
    }
    if (!mainVM) return false;
    globalVM = riveInstance.globalViewModelInstance("LightsGlobal");
    if (!globalVM) {
      const definition = riveInstance.viewModelByName("LightsGlobal");
      const instance = definition && definition.defaultInstance();
      if (instance && riveInstance.setGlobalViewModelInstance("LightsGlobal", instance)) {
        riveInstance.bind();
        globalVM = riveInstance.globalViewModelInstance("LightsGlobal");
      }
    }
    if (!globalVM) {
      console.error("[Pisca V2] LightsGlobal could not be bound");
      return false;
    }
    return true;
  }

  function setupResize() {
    if (!canvas) return;
    if (resizeObserver) resizeObserver.disconnect();
    if (window["ResizeObserver"]) {
      resizeObserver = new window["ResizeObserver"](resizeRive);
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", resizeRive);
    }
  }

  function createRiveInstance(api) {
    if (!canvas) throw new Error("Missing #pisca-canvas in the HTML tab");
    if (api.RuntimeLoader && api.RuntimeLoader.setWasmUrl) {
      api.RuntimeLoader.setWasmUrl(RIVE_WASM_SRC);
    }
    return new Promise((resolve, reject) => {
      riveInstance = new api.Rive({
        src: RIV_URL,
        canvas: canvas,
        artboard: ARTBOARD,
        stateMachines: STATE_MACHINE,
        autoplay: true,
        autoBind: true,
        layout: new api.Layout({
          fit: api.Fit.Contain,
          alignment: api.Alignment.Center
        }),
        onLoad: () => {
          try {
            if (!bindViewModels()) {
              reject(new Error("ViewModel1 could not be bound"));
              return;
            }
            applyConfig();
            resizeRive();
            setupResize();
            applyBulbTypes();
            ready = true;
            processAlertQueue();
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        onLoadError: reject
      });
    });
  }

  function startRive() {
    if (!canvas || riveInstance || startPromise) return;
    startPromise = loadRiveRuntime()
      .then(createRiveInstance)
      .catch(error => {
        console.error("[Pisca V2]", error);
        ready = false;
        if (riveInstance) riveInstance.cleanup();
        riveInstance = null;
        mainVM = null;
        globalVM = null;
      })
      .finally(() => {
        startPromise = null;
      });
  }

  window.addEventListener("onWidgetLoad", object => {
    const data = object && object.detail && object.detail.fieldData;
    fields = { ...DEFAULTS, ...(data || {}) };
    if (ready) {
      applyConfig();
      applyBulbTypes();
    } else {
      startRive();
    }
  });

  window.addEventListener("onEventReceived", onEventReceived);

  window.addEventListener("beforeunload", () => {
    ready = false;
    if (resizeObserver) resizeObserver.disconnect();
    if (riveInstance) riveInstance.cleanup();
    riveInstance = null;
    mainVM = null;
    globalVM = null;
    alertQueue.length = 0;
  });
})();
