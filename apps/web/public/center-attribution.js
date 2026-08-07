/**
 * Captura de atribuição do Center Analytics.
 *
 * Faz duas coisas, e a segunda é a que importa:
 *  1. Envia um "toque" de atribuição para a nossa API (rede de segurança).
 *  2. Escreve o client_id do GA4 num campo oculto do checkout, para que a loja
 *     o envie à Uappi em `informacoesAdicionais.centerVisitorId` — é assim que
 *     o pedido chega já atribuído.
 *
 * Sem PII: o client_id do GA4 é um identificador de navegador, e nós o
 * convertemos em HMAC assim que chega ao servidor. Nenhum e-mail é enviado por
 * este script a menos que a loja preencha explicitamente `centerEmail`.
 */
(function () {
  'use strict';

  var CONFIG = window.CENTER_ATTRIBUTION || {};
  var API_URL = CONFIG.apiUrl;
  var ORGANIZATION_ID = CONFIG.organizationId;
  var STORAGE_KEY = 'center.attribution';
  var TTL_MS = 30 * 24 * 60 * 60 * 1000;

  if (!API_URL || !ORGANIZATION_ID) return;

  /** O cookie _ga tem o formato GA1.1.<client_id>. */
  function readGaClientId() {
    var match = document.cookie.match(/_ga=GA\d\.\d\.(\d+\.\d+)/);
    return match ? match[1] : null;
  }

  function readUtms() {
    var params = new URLSearchParams(window.location.search);
    return {
      source: params.get('utm_source'),
      medium: params.get('utm_medium'),
      campaign: params.get('utm_campaign'),
    };
  }

  function detectDevice() {
    if (/Tablet|iPad/i.test(navigator.userAgent)) return 'tablet';
    if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) return 'mobile';
    return 'desktop';
  }

  function loadStored() {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (stored && Date.now() - stored.savedAt < TTL_MS) return stored;
    } catch (error) {
      // localStorage bloqueado (modo privado): seguimos sem persistência.
    }
    return null;
  }

  function save(record) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (error) {
      // Sem persistência, a atribuição vale só para esta navegação.
    }
  }

  var clientId = readGaClientId();
  if (!clientId) return;

  var utms = readUtms();
  var stored = loadStored();

  // Primeiro toque com UTM vence: a campanha que trouxe o visitante é a que
  // deve receber o crédito, não a última página que ele visitou.
  var record = {
    clientId: clientId,
    source: utms.source || (stored && stored.source) || null,
    medium: utms.medium || (stored && stored.medium) || null,
    campaign: utms.campaign || (stored && stored.campaign) || null,
    device: detectDevice(),
    landingPage: (stored && stored.landingPage) || window.location.pathname,
    savedAt: (stored && stored.savedAt) || Date.now(),
  };
  save(record);

  // (2) Campo oculto — o caminho preciso. A loja precisa enviá-lo à Uappi.
  function fillHiddenField() {
    var field = document.querySelector('[name="centerVisitorId"]');
    if (field) field.value = clientId;

    var campaignField = document.querySelector('[name="centerUtmCampaign"]');
    if (campaignField) campaignField.value = record.campaign || '';

    var sourceField = document.querySelector('[name="centerUtmSource"]');
    if (sourceField) sourceField.value = record.source || '';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fillHiddenField);
  } else {
    fillHiddenField();
  }

  // (1) Toque para a nossa API — best effort, nunca bloqueia a página.
  var payload = JSON.stringify({
    organizationId: ORGANIZATION_ID,
    clientId: record.clientId,
    source: record.source,
    medium: record.medium,
    campaign: record.campaign,
    device: record.device,
    landingPage: record.landingPage,
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_URL + '/public/attribution', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch(API_URL + '/public/attribution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function () {});
  }
})();
