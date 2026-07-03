/**
 * BrokerSpreadConfig — per-symbol spread configuration for the IGFX internal B-book.
 *
 * Priority in InternalLiquidityCore:
 *   1. Real bid/ask from TwelveData paid-plan feed          → always wins
 *   2. Last observed real spread from SpreadStore            → used for stocks after hours
 *   3. Broker-configured spread from this module            → applied to indices / commodities
 *   4. None of the above                                     → zero spread → order rejected
 *
 * Storage:
 *   BrokerSetting table, key = "broker_spread:<SYMBOL>", value = SpreadEntry JSON.
 *   In-memory cache is the authoritative read path — DB is written through only.
 *
 * 120+ instruments across: Forex Majors/Minors/Exotics, Crypto, Indices,
 * Metals, Energy, Agricultural Commodities, US Equities, European Equities.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssetClass = "FOREX" | "CRYPTO" | "INDEX" | "COMMODITY" | "METAL" | "EQUITY_US" | "EQUITY_EU" | "EQUITY_ASIA";

export type InstrumentMeta = {
  symbol:       string;
  name:         string;
  assetClass:   AssetClass;
  pipSize:      number;
  contractSize: number;
  minLot:       number;
  maxLot:       number;
  leverage:     number;
  currency:     string;
  exchange?:    string;
  region?:      string;
};

export type SpreadEntry = {
  symbol:    string;
  spread:    number;
  enabled:   boolean;
  updatedAt: string;
  updatedBy: string;
};

export type SpreadSource = "real" | "broker_config" | "last_real" | "zero";

// ─── Instrument Metadata ──────────────────────────────────────────────────────

export const INSTRUMENT_META: Record<string, InstrumentMeta> = {
  // Forex Majors
  EURUSD: { symbol:"EURUSD", name:"Euro / US Dollar",                 assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"USD" },
  GBPUSD: { symbol:"GBPUSD", name:"British Pound / US Dollar",        assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"USD" },
  USDJPY: { symbol:"USDJPY", name:"US Dollar / Japanese Yen",         assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"JPY" },
  USDCHF: { symbol:"USDCHF", name:"US Dollar / Swiss Franc",          assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"CHF" },
  USDCAD: { symbol:"USDCAD", name:"US Dollar / Canadian Dollar",      assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"CAD" },
  AUDUSD: { symbol:"AUDUSD", name:"Australian Dollar / US Dollar",    assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"USD" },
  NZDUSD: { symbol:"NZDUSD", name:"New Zealand Dollar / US Dollar",   assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"USD" },
  EURGBP: { symbol:"EURGBP", name:"Euro / British Pound",             assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:100, leverage:30, currency:"GBP" },
  // Forex Minors
  EURJPY: { symbol:"EURJPY", name:"Euro / Japanese Yen",              assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  GBPJPY: { symbol:"GBPJPY", name:"British Pound / Japanese Yen",     assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  EURCHF: { symbol:"EURCHF", name:"Euro / Swiss Franc",               assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CHF" },
  GBPCHF: { symbol:"GBPCHF", name:"British Pound / Swiss Franc",      assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CHF" },
  EURAUD: { symbol:"EURAUD", name:"Euro / Australian Dollar",         assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"AUD" },
  GBPAUD: { symbol:"GBPAUD", name:"British Pound / Australian Dollar",assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"AUD" },
  EURCAD: { symbol:"EURCAD", name:"Euro / Canadian Dollar",           assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CAD" },
  GBPCAD: { symbol:"GBPCAD", name:"British Pound / Canadian Dollar",  assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CAD" },
  AUDCAD: { symbol:"AUDCAD", name:"AUD / Canadian Dollar",            assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CAD" },
  AUDCHF: { symbol:"AUDCHF", name:"AUD / Swiss Franc",                assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CHF" },
  AUDJPY: { symbol:"AUDJPY", name:"AUD / Japanese Yen",               assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  NZDJPY: { symbol:"NZDJPY", name:"New Zealand Dollar / JPY",         assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  CADJPY: { symbol:"CADJPY", name:"Canadian Dollar / JPY",            assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  CHFJPY: { symbol:"CHFJPY", name:"Swiss Franc / Japanese Yen",       assetClass:"FOREX",     pipSize:0.01,   contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"JPY" },
  EURNZD: { symbol:"EURNZD", name:"Euro / New Zealand Dollar",        assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"NZD" },
  GBPNZD: { symbol:"GBPNZD", name:"British Pound / NZD",              assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"NZD" },
  AUDNZD: { symbol:"AUDNZD", name:"AUD / New Zealand Dollar",         assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"NZD" },
  NZDCAD: { symbol:"NZDCAD", name:"NZD / Canadian Dollar",            assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CAD" },
  NZDCHF: { symbol:"NZDCHF", name:"NZD / Swiss Franc",                assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CHF" },
  CADCHF: { symbol:"CADCHF", name:"Canadian Dollar / Swiss Franc",    assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:50, leverage:30, currency:"CHF" },
  // Forex Exotics
  USDTRY: { symbol:"USDTRY", name:"US Dollar / Turkish Lira",         assetClass:"FOREX",     pipSize:0.001,  contractSize:100_000, minLot:0.01, maxLot:10, leverage:10, currency:"TRY" },
  USDMXN: { symbol:"USDMXN", name:"US Dollar / Mexican Peso",         assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:10, leverage:10, currency:"MXN" },
  USDZAR: { symbol:"USDZAR", name:"US Dollar / South African Rand",   assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:10, leverage:10, currency:"ZAR" },
  USDNOK: { symbol:"USDNOK", name:"US Dollar / Norwegian Krone",      assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"NOK" },
  USDSEK: { symbol:"USDSEK", name:"US Dollar / Swedish Krona",        assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"SEK" },
  USDDKK: { symbol:"USDDKK", name:"US Dollar / Danish Krone",         assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"DKK" },
  USDSGD: { symbol:"USDSGD", name:"US Dollar / Singapore Dollar",     assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"SGD" },
  USDHKD: { symbol:"USDHKD", name:"US Dollar / Hong Kong Dollar",     assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"HKD" },
  USDPLN: { symbol:"USDPLN", name:"US Dollar / Polish Zloty",         assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"PLN" },
  EURTRY: { symbol:"EURTRY", name:"Euro / Turkish Lira",              assetClass:"FOREX",     pipSize:0.001,  contractSize:100_000, minLot:0.01, maxLot:10, leverage:10, currency:"TRY" },
  GBPTRY: { symbol:"GBPTRY", name:"British Pound / Turkish Lira",     assetClass:"FOREX",     pipSize:0.001,  contractSize:100_000, minLot:0.01, maxLot:10, leverage:10, currency:"TRY" },
  EURNOK: { symbol:"EURNOK", name:"Euro / Norwegian Krone",           assetClass:"FOREX",     pipSize:0.0001, contractSize:100_000, minLot:0.01, maxLot:20, leverage:20, currency:"NOK" },
  // Cryptocurrencies
  BTCUSD:  { symbol:"BTCUSD",  name:"Bitcoin / US Dollar",            assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.001, maxLot:10,        leverage:2, currency:"USD" },
  ETHUSD:  { symbol:"ETHUSD",  name:"Ethereum / US Dollar",           assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.01,  maxLot:100,       leverage:2, currency:"USD" },
  XRPUSD:  { symbol:"XRPUSD",  name:"Ripple / US Dollar",             assetClass:"CRYPTO",    pipSize:0.0001,  contractSize:1, minLot:1,     maxLot:100_000,   leverage:2, currency:"USD" },
  LTCUSD:  { symbol:"LTCUSD",  name:"Litecoin / US Dollar",           assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.01,  maxLot:1_000,     leverage:2, currency:"USD" },
  SOLUSD:  { symbol:"SOLUSD",  name:"Solana / US Dollar",             assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.01,  maxLot:1_000,     leverage:2, currency:"USD" },
  BNBUSD:  { symbol:"BNBUSD",  name:"BNB / US Dollar",                assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.01,  maxLot:500,       leverage:2, currency:"USD" },
  ADAUSD:  { symbol:"ADAUSD",  name:"Cardano / US Dollar",            assetClass:"CRYPTO",    pipSize:0.0001,  contractSize:1, minLot:1,     maxLot:500_000,   leverage:2, currency:"USD" },
  DOTUSD:  { symbol:"DOTUSD",  name:"Polkadot / US Dollar",           assetClass:"CRYPTO",    pipSize:0.0001,  contractSize:1, minLot:0.1,   maxLot:50_000,    leverage:2, currency:"USD" },
  DOGEUSD: { symbol:"DOGEUSD", name:"Dogecoin / US Dollar",           assetClass:"CRYPTO",    pipSize:0.00001, contractSize:1, minLot:10,    maxLot:1_000_000, leverage:2, currency:"USD" },
  AVAXUSD: { symbol:"AVAXUSD", name:"Avalanche / US Dollar",          assetClass:"CRYPTO",    pipSize:0.01,    contractSize:1, minLot:0.1,   maxLot:10_000,    leverage:2, currency:"USD" },
  LINKUSD: { symbol:"LINKUSD", name:"Chainlink / US Dollar",          assetClass:"CRYPTO",    pipSize:0.001,   contractSize:1, minLot:0.1,   maxLot:50_000,    leverage:2, currency:"USD" },
  UNIUSD:  { symbol:"UNIUSD",  name:"Uniswap / US Dollar",            assetClass:"CRYPTO",    pipSize:0.001,   contractSize:1, minLot:0.1,   maxLot:50_000,    leverage:2, currency:"USD" },
  ATOMUSD: { symbol:"ATOMUSD", name:"Cosmos / US Dollar",             assetClass:"CRYPTO",    pipSize:0.001,   contractSize:1, minLot:0.1,   maxLot:50_000,    leverage:2, currency:"USD" },
  MATICUSD:{ symbol:"MATICUSD",name:"Polygon / US Dollar",            assetClass:"CRYPTO",    pipSize:0.0001,  contractSize:1, minLot:1,     maxLot:500_000,   leverage:2, currency:"USD" },
  NEARUSD: { symbol:"NEARUSD", name:"NEAR Protocol / US Dollar",      assetClass:"CRYPTO",    pipSize:0.0001,  contractSize:1, minLot:0.1,   maxLot:100_000,   leverage:2, currency:"USD" },
  // Stock Indices
  US500:  { symbol:"US500",  name:"S&P 500 Index",                    assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:50,  leverage:20, currency:"USD", exchange:"CME" },
  US100:  { symbol:"US100",  name:"Nasdaq-100 Index",                 assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:50,  leverage:20, currency:"USD", exchange:"CME" },
  US30:   { symbol:"US30",   name:"Dow Jones Industrial Average",     assetClass:"INDEX", pipSize:1.0, contractSize:1, minLot:0.1, maxLot:50,  leverage:20, currency:"USD", exchange:"CME" },
  DE40:   { symbol:"DE40",   name:"DAX 40 Index",                     assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:30,  leverage:20, currency:"EUR", exchange:"EUREX" },
  UK100:  { symbol:"UK100",  name:"FTSE 100 Index",                   assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:30,  leverage:20, currency:"GBP", exchange:"ICE" },
  JP225:  { symbol:"JP225",  name:"Nikkei 225 Index",                 assetClass:"INDEX", pipSize:1.0, contractSize:1, minLot:0.1, maxLot:20,  leverage:10, currency:"JPY", exchange:"OSE" },
  AU200:  { symbol:"AU200",  name:"ASX 200 Index",                    assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:20,  leverage:20, currency:"AUD", exchange:"ASX" },
  EU50:   { symbol:"EU50",   name:"Euro Stoxx 50 Index",              assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:30,  leverage:20, currency:"EUR", exchange:"EUREX" },
  FR40:   { symbol:"FR40",   name:"CAC 40 Index",                     assetClass:"INDEX", pipSize:0.1, contractSize:1, minLot:0.1, maxLot:20,  leverage:20, currency:"EUR", exchange:"EURONEXT" },
  ES35:   { symbol:"ES35",   name:"IBEX 35 Index",                    assetClass:"INDEX", pipSize:1.0, contractSize:1, minLot:0.1, maxLot:20,  leverage:20, currency:"EUR", exchange:"BME" },
  HK50:   { symbol:"HK50",   name:"Hang Seng Index",                  assetClass:"INDEX", pipSize:1.0, contractSize:1, minLot:0.1, maxLot:20,  leverage:10, currency:"HKD", exchange:"HKEX" },
  CN50:   { symbol:"CN50",   name:"FTSE China 50 Index",              assetClass:"INDEX", pipSize:1.0, contractSize:1, minLot:0.1, maxLot:20,  leverage:10, currency:"USD", exchange:"SGX" },
  // Precious Metals
  XAUUSD: { symbol:"XAUUSD", name:"Gold / US Dollar",   assetClass:"METAL", pipSize:0.01,   contractSize:100,    minLot:0.01, maxLot:50,  leverage:20, currency:"USD" },
  XAGUSD: { symbol:"XAGUSD", name:"Silver / US Dollar", assetClass:"METAL", pipSize:0.001,  contractSize:5_000,  minLot:0.01, maxLot:100, leverage:10, currency:"USD" },
  XPTUSD: { symbol:"XPTUSD", name:"Platinum / USD",     assetClass:"METAL", pipSize:0.01,   contractSize:50,     minLot:0.01, maxLot:20,  leverage:10, currency:"USD" },
  XPDUSD: { symbol:"XPDUSD", name:"Palladium / USD",    assetClass:"METAL", pipSize:0.01,   contractSize:100,    minLot:0.01, maxLot:10,  leverage:10, currency:"USD" },
  COPPER: { symbol:"COPPER", name:"Copper (US¢/lb)",    assetClass:"METAL", pipSize:0.0001, contractSize:25_000, minLot:0.01, maxLot:20,  leverage:10, currency:"USD" },
  // Energy Commodities
  WTI:    { symbol:"WTI",    name:"WTI Crude Oil",    assetClass:"COMMODITY", pipSize:0.001,  contractSize:1_000,  minLot:0.01, maxLot:100, leverage:10, currency:"USD" },
  BRENT:  { symbol:"BRENT",  name:"Brent Crude Oil",  assetClass:"COMMODITY", pipSize:0.001,  contractSize:1_000,  minLot:0.01, maxLot:100, leverage:10, currency:"USD" },
  NATGAS: { symbol:"NATGAS", name:"Natural Gas",      assetClass:"COMMODITY", pipSize:0.001,  contractSize:10_000, minLot:0.1,  maxLot:50,  leverage:10, currency:"USD" },
  HEATOIL:{ symbol:"HEATOIL",name:"Heating Oil",      assetClass:"COMMODITY", pipSize:0.0001, contractSize:42_000, minLot:0.01, maxLot:20,  leverage:10, currency:"USD" },
  // Agricultural Commodities
  WHEAT:   { symbol:"WHEAT",   name:"Wheat (¢/bushel)",  assetClass:"COMMODITY", pipSize:0.25,  contractSize:5_000,   minLot:0.01, maxLot:20, leverage:10, currency:"USD", exchange:"CBOT" },
  CORN:    { symbol:"CORN",    name:"Corn (¢/bushel)",   assetClass:"COMMODITY", pipSize:0.25,  contractSize:5_000,   minLot:0.01, maxLot:20, leverage:10, currency:"USD", exchange:"CBOT" },
  SOYBEANS:{ symbol:"SOYBEANS",name:"Soybeans (¢/bu)",   assetClass:"COMMODITY", pipSize:0.25,  contractSize:5_000,   minLot:0.01, maxLot:20, leverage:10, currency:"USD", exchange:"CBOT" },
  SUGAR:   { symbol:"SUGAR",   name:"Sugar No. 11",      assetClass:"COMMODITY", pipSize:0.001, contractSize:112_000, minLot:0.01, maxLot:10, leverage:10, currency:"USD", exchange:"ICE" },
  COFFEE:  { symbol:"COFFEE",  name:"Coffee C",          assetClass:"COMMODITY", pipSize:0.05,  contractSize:37_500,  minLot:0.01, maxLot:10, leverage:10, currency:"USD", exchange:"ICE" },
  COCOA:   { symbol:"COCOA",   name:"Cocoa ($/MT)",      assetClass:"COMMODITY", pipSize:1.0,   contractSize:10,      minLot:0.01, maxLot:10, leverage:10, currency:"USD", exchange:"ICE" },
  COTTON:  { symbol:"COTTON",  name:"Cotton No. 2",      assetClass:"COMMODITY", pipSize:0.01,  contractSize:50_000,  minLot:0.01, maxLot:10, leverage:10, currency:"USD", exchange:"ICE" },
  // US Equities
  AAPL:  { symbol:"AAPL",  name:"Apple Inc.",                   assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:10_000, leverage:5, currency:"USD", exchange:"NASDAQ" },
  MSFT:  { symbol:"MSFT",  name:"Microsoft Corp.",              assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:10_000, leverage:5, currency:"USD", exchange:"NASDAQ" },
  NVDA:  { symbol:"NVDA",  name:"NVIDIA Corp.",                 assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  TSLA:  { symbol:"TSLA",  name:"Tesla Inc.",                   assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  AMZN:  { symbol:"AMZN",  name:"Amazon.com Inc.",              assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  GOOGL: { symbol:"GOOGL", name:"Alphabet Inc. (Class A)",      assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  META:  { symbol:"META",  name:"Meta Platforms Inc.",          assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  NFLX:  { symbol:"NFLX",  name:"Netflix Inc.",                 assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  BABA:  { symbol:"BABA",  name:"Alibaba Group Holding Ltd.",   assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  JPM:   { symbol:"JPM",   name:"JPMorgan Chase & Co.",         assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  GS:    { symbol:"GS",    name:"Goldman Sachs Group Inc.",     assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  BAC:   { symbol:"BAC",   name:"Bank of America Corp.",        assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  WMT:   { symbol:"WMT",   name:"Walmart Inc.",                 assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  PG:    { symbol:"PG",    name:"Procter & Gamble Co.",         assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  KO:    { symbol:"KO",    name:"Coca-Cola Co.",                assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  DIS:   { symbol:"DIS",   name:"Walt Disney Co.",              assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  V:     { symbol:"V",     name:"Visa Inc.",                    assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  MA:    { symbol:"MA",    name:"Mastercard Inc.",              assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  PYPL:  { symbol:"PYPL",  name:"PayPal Holdings Inc.",         assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  CRM:   { symbol:"CRM",   name:"Salesforce Inc.",              assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  ORCL:  { symbol:"ORCL",  name:"Oracle Corp.",                assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  INTC:  { symbol:"INTC",  name:"Intel Corp.",                  assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  AMD:   { symbol:"AMD",   name:"Advanced Micro Devices Inc.",  assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  QCOM:  { symbol:"QCOM",  name:"Qualcomm Inc.",                assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  UBER:  { symbol:"UBER",  name:"Uber Technologies Inc.",       assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  SPOT:  { symbol:"SPOT",  name:"Spotify Technology SA",        assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:1_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  SHOP:  { symbol:"SHOP",  name:"Shopify Inc.",                 assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:1_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  COIN:  { symbol:"COIN",  name:"Coinbase Global Inc.",         assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:1_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  PLTR:  { symbol:"PLTR",  name:"Palantir Technologies Inc.",   assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  XOM:   { symbol:"XOM",   name:"ExxonMobil Corp.",             assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  CVX:   { symbol:"CVX",   name:"Chevron Corp.",                assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  MRNA:  { symbol:"MRNA",  name:"Moderna Inc.",                 assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:1_000,  leverage:5, currency:"USD", exchange:"NASDAQ" },
  PFE:   { symbol:"PFE",   name:"Pfizer Inc.",                  assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:5_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  JNJ:   { symbol:"JNJ",   name:"Johnson & Johnson",            assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  SQ:    { symbol:"SQ",    name:"Block Inc.",                   assetClass:"EQUITY_US", pipSize:0.01, contractSize:1, minLot:1, maxLot:2_000,  leverage:5, currency:"USD", exchange:"NYSE" },
  // European Equities
  SAP:  { symbol:"SAP",  name:"SAP SE",                   assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"EUR", exchange:"XETRA",    region:"DE" },
  LVMH: { symbol:"LVMH", name:"LVMH Moët Hennessy",       assetClass:"EQUITY_EU", pipSize:0.1,   contractSize:1, minLot:1, maxLot:200,   leverage:5, currency:"EUR", exchange:"EURONEXT", region:"FR" },
  ASML: { symbol:"ASML", name:"ASML Holding N.V.",         assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:200,   leverage:5, currency:"EUR", exchange:"EURONEXT", region:"NL" },
  NESN: { symbol:"NESN", name:"Nestlé S.A.",               assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"CHF", exchange:"SIX",      region:"CH" },
  NOVO: { symbol:"NOVO", name:"Novo Nordisk A/S",          assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"DKK", exchange:"NASDAQ-CPH",region:"DK" },
  BMW:  { symbol:"BMW",  name:"Bayerische Motoren Werke",  assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"EUR", exchange:"XETRA",    region:"DE" },
  SIE:  { symbol:"SIE",  name:"Siemens AG",                assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"EUR", exchange:"XETRA",    region:"DE" },
  BAYN: { symbol:"BAYN", name:"Bayer AG",                  assetClass:"EQUITY_EU", pipSize:0.01,  contractSize:1, minLot:1, maxLot:500,   leverage:5, currency:"EUR", exchange:"XETRA",    region:"DE" },
  HSBA: { symbol:"HSBA", name:"HSBC Holdings plc",         assetClass:"EQUITY_EU", pipSize:0.001, contractSize:1, minLot:1, maxLot:5_000, leverage:5, currency:"GBP", exchange:"LSE",      region:"UK" },
  BP:   { symbol:"BP",   name:"BP plc",                    assetClass:"EQUITY_EU", pipSize:0.001, contractSize:1, minLot:1, maxLot:5_000, leverage:5, currency:"GBP", exchange:"LSE",      region:"UK" },
  SHEL: { symbol:"SHEL", name:"Shell plc",                 assetClass:"EQUITY_EU", pipSize:0.001, contractSize:1, minLot:1, maxLot:2_000, leverage:5, currency:"GBP", exchange:"LSE",      region:"UK" },
  RIO:  { symbol:"RIO",  name:"Rio Tinto plc",             assetClass:"EQUITY_EU", pipSize:0.001, contractSize:1, minLot:1, maxLot:1_000, leverage:5, currency:"GBP", exchange:"LSE",      region:"UK" },
};

// ─── Broker Spread Defaults ───────────────────────────────────────────────────

export const BROKER_SPREAD_DEFAULTS: Record<string, number> = {
  // Forex Majors
  EURUSD:0.00013, GBPUSD:0.00016, USDJPY:0.018,   USDCHF:0.00015,
  USDCAD:0.00016, AUDUSD:0.00015, NZDUSD:0.00018, EURGBP:0.00012,
  // Forex Minors
  EURJPY:0.022,   GBPJPY:0.028,   EURCHF:0.00016, GBPCHF:0.00020,
  EURAUD:0.00022, GBPAUD:0.00028, EURCAD:0.00020, GBPCAD:0.00028,
  AUDCAD:0.00020, AUDCHF:0.00020, AUDJPY:0.022,   NZDJPY:0.028,
  CADJPY:0.022,   CHFJPY:0.028,   EURNZD:0.00028, GBPNZD:0.00035,
  AUDNZD:0.00020, NZDCAD:0.00022, NZDCHF:0.00025, CADCHF:0.00018,
  // Forex Exotics
  USDTRY:0.040,   USDMXN:0.015,   USDZAR:0.025,   USDNOK:0.008,
  USDSEK:0.010,   USDDKK:0.002,   USDSGD:0.0004,  USDHKD:0.0002,
  USDPLN:0.003,   EURTRY:0.060,   GBPTRY:0.075,   EURNOK:0.010,
  // Cryptocurrencies
  BTCUSD:30.00,   ETHUSD:1.20,    XRPUSD:0.0003,  LTCUSD:0.15,
  SOLUSD:0.08,    BNBUSD:0.20,    ADAUSD:0.0005,  DOTUSD:0.004,
  DOGEUSD:0.00005,AVAXUSD:0.08,   LINKUSD:0.010,  UNIUSD:0.008,
  ATOMUSD:0.010,  MATICUSD:0.0003,NEARUSD:0.003,
  // Stock Indices
  US500:0.80,  US100:1.50, US30:3.00,  DE40:1.20, UK100:1.00,
  JP225:6.00,  AU200:1.20, EU50:1.20,  FR40:1.20, ES35:5.00,
  HK50:5.00,   CN50:8.00,
  // Precious Metals
  XAUUSD:0.30, XAGUSD:0.020, XPTUSD:2.00, XPDUSD:5.00, COPPER:0.005,
  // Energy Commodities
  WTI:0.025, BRENT:0.025, NATGAS:0.004, HEATOIL:0.0008,
  // Agricultural Commodities
  WHEAT:0.50, CORN:0.30, SOYBEANS:0.50, SUGAR:0.005,
  COFFEE:0.10, COCOA:5.00, COTTON:0.030,
  // US Equities
  AAPL:0.04,  MSFT:0.04,  NVDA:0.08,  TSLA:0.06,  AMZN:0.04,
  GOOGL:0.04, META:0.04,  NFLX:0.08,  BABA:0.06,  JPM:0.04,
  GS:0.06,    BAC:0.03,   WMT:0.04,   PG:0.03,    KO:0.02,
  DIS:0.04,   V:0.03,     MA:0.04,    PYPL:0.05,  CRM:0.06,
  ORCL:0.04,  INTC:0.03,  AMD:0.04,   QCOM:0.04,  UBER:0.03,
  SPOT:0.10,  SHOP:0.10,  COIN:0.10,  PLTR:0.03,  XOM:0.04,
  CVX:0.04,   MRNA:0.08,  PFE:0.02,   JNJ:0.05,   SQ:0.06,
  // European Equities
  SAP:0.05,  LVMH:0.50, ASML:0.10, NESN:0.05, NOVO:0.50,
  BMW:0.08,  SIE:0.08,  BAYN:0.06, HSBA:0.003,BP:0.003,
  SHEL:0.005,RIO:0.010,
};

// Complete list of IGFX tradeable instruments (120+ symbols)
export const ALL_SYMBOLS = Object.keys(BROKER_SPREAD_DEFAULTS);

// Instruments grouped by asset class for UI display
export const SYMBOLS_BY_CLASS: Record<AssetClass, string[]> = {
  FOREX:       Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "FOREX"),
  CRYPTO:      Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "CRYPTO"),
  INDEX:       Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "INDEX"),
  COMMODITY:   Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "COMMODITY"),
  METAL:       Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "METAL"),
  EQUITY_US:   Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "EQUITY_US"),
  EQUITY_EU:   Object.keys(INSTRUMENT_META).filter(s => INSTRUMENT_META[s]?.assetClass === "EQUITY_EU"),
  EQUITY_ASIA: [],
};

// ─── BrokerSpreadConfig ───────────────────────────────────────────────────────

export class BrokerSpreadConfig {
  private readonly cache = new Map<string, SpreadEntry>();

  async load(): Promise<void> {
    if (!IS_PERSISTENT) {
      console.log(`[broker-spread] ${ALL_SYMBOLS.length} instruments loaded (in-memory defaults)`);
      return;
    }

    try {
      const db   = prisma as NonNullable<typeof prisma>;
      const rows = await db.brokerSetting.findMany({
        where: { key: { startsWith: "broker_spread:" } },
      });

      for (const row of rows) {
        const entry = row.value as SpreadEntry;
        if (entry?.symbol) {
          this.cache.set(entry.symbol.toUpperCase(), entry);
        }
      }

      console.log(`[broker-spread] ${ALL_SYMBOLS.length} instruments available, ${rows.length} DB override(s) loaded`);
    } catch (err) {
      console.warn("[broker-spread] DB load failed — using defaults:", (err as Error).message);
    }
  }

  /**
   * Returns the configured spread in price units for a symbol.
   * Prefers a DB override over the built-in default.
   * Returns null only if the symbol is completely unknown.
   */
  getSpread(symbol: string): number | null {
    const key  = symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached.spread;
    return BROKER_SPREAD_DEFAULTS[key] ?? null;
  }

  getMeta(symbol: string): InstrumentMeta | null {
    return INSTRUMENT_META[symbol.toUpperCase()] ?? null;
  }

  getByClass(assetClass: AssetClass): string[] {
    return SYMBOLS_BY_CLASS[assetClass] ?? [];
  }

  isEnabled(symbol: string): boolean {
    const cached = this.cache.get(symbol.toUpperCase());
    return cached?.enabled ?? true;
  }

  /**
   * Returns all spread entries for admin display.
   * Merges DB overrides with built-in defaults.
   */
  getAll(): Record<string, SpreadEntry> {
    const now    = new Date().toISOString();
    const result: Record<string, SpreadEntry> = {};

    for (const sym of ALL_SYMBOLS) {
      const cached = this.cache.get(sym);
      result[sym] = cached ?? {
        symbol:    sym,
        spread:    BROKER_SPREAD_DEFAULTS[sym] ?? 0,
        enabled:   true,
        updatedAt: now,
        updatedBy: "default",
      };
    }

    return result;
  }

  /**
   * Update spread and/or enabled state for a symbol.
   * Persists to BrokerSetting and updates in-memory cache.
   */
  async update(
    symbol:  string,
    spread:  number,
    enabled: boolean,
    adminId: string,
  ): Promise<SpreadEntry> {
    const key   = symbol.toUpperCase();
    const entry: SpreadEntry = {
      symbol:    key,
      spread:    Math.max(0, spread),
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: adminId,
    };

    this.cache.set(key, entry);

    if (IS_PERSISTENT) {
      const db = prisma as NonNullable<typeof prisma>;
      await db.brokerSetting.upsert({
        where:  { key: `broker_spread:${key}` },
        create: { key: `broker_spread:${key}`, value: entry as object },
        update: { value: entry as object },
      });
    }

    console.log(
      `[broker-spread] ${key}: spread=${entry.spread} enabled=${entry.enabled} by=${adminId}`
    );

    return entry;
  }
}

export const brokerSpreadConfig = new BrokerSpreadConfig();
