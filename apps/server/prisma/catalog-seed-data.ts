export type CatalogSeedProduct = {
  businessName: string;
  sku: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  specifications: string;
  packSize?: string;
  sourceUrl: string;
};

const exideXplore = "https://www.exidecare.com/brand/exide-xplore.aspx";
const exideDrive = "https://www.exidecare.com/brand/exide-drive.aspx";
const exideDare = "https://www.exidecare.com/brand/exide-dare";
const exideRide = "https://www.exidecare.com/brand/exide-ride.aspx";
const exideJaiKisan = "https://www.exidecare.com/brand/exide-jai-kisaan.aspx";
const microtekInverters = "https://www.microtek.in/product/power-backup-solutions/best-inverter-for-home-india/listing?product_series=7";
const microtekBatteries = "https://www.microtek.in/product/power-backup-solutions/inverter-battery/listing";
const tractorSparc = "https://www.asianpaints.com/paint-products/interior-wall-paints/plain-finishes/tractor-sparc.html";
const castrolActiv = "https://www.castrol.com/en_in/india/home/products/our-brands/two-wheelers/activ.html";
const castrolPower1 = "https://www.castrol.com/en_in/india/home/products/our-brands/two-wheelers/power1.html";
const castrolGtx = "https://www.castrol.com/en_in/india/home/products/our-brands/automotive/gtx.html";

const exideBattery = (
  range: string,
  model: string,
  capacityAh: number,
  dimensionsMm: string,
  sourceUrl: string,
  extra = "",
): CatalogSeedProduct => ({
  businessName: "SANTHOSH AUTOMOBILES",
  sku: model,
  name: `Exide ${range} ${model}`,
  brand: "Exide",
  model,
  category: range,
  specifications: [`${capacityAh} Ah`, `${dimensionsMm} mm`, extra].filter(Boolean).join("; "),
  sourceUrl,
});

const microtekProduct = (
  sku: string,
  name: string,
  category: string,
  model: string,
  specifications: string,
  sourceUrl: string,
): CatalogSeedProduct => ({
  businessName: "ARJUNA AGENCY",
  sku,
  name,
  brand: "Microtek",
  model,
  category,
  specifications,
  sourceUrl,
});

const paintProduct = (name: string, slug: string, category: string, sourceUrl: string, packSize?: string) => ({
  businessName: "ARJUNA ENTERPRISES",
  sku: `CAT-ASIANPAINTS-${slug.toUpperCase()}${packSize ? `-${packSize.replace(/[^A-Z0-9]/gi, "").toUpperCase()}` : ""}`,
  name,
  brand: "Asian Paints",
  model: name,
  category,
  specifications: "Manufacturer catalogue item; verify the exact shade/formulation before pricing.",
  ...(packSize ? { packSize } : {}),
  sourceUrl,
});

const oilProduct = (name: string, grade: string, category: string, sourceUrl: string) => ({
  businessName: "ARJUNA ENTERPRISES",
  sku: `CAT-CASTROL-${name}-${grade}`.toUpperCase().replace(/[^A-Z0-9-]/g, "-"),
  name: `Castrol ${name} ${grade}`,
  brand: "Castrol",
  model: `${name} ${grade}`,
  category,
  specifications: `Manufacturer-published viscosity grade: ${grade}. Confirm engine compatibility from the vehicle manual.`,
  sourceUrl,
});

export const catalogSeedProducts: CatalogSeedProduct[] = [
  ...[
    ["899-981-0850", "Microtek iMERLYN UPS 850 (12V)", "Inverter", "iMERLYN UPS 850", "715 VA / 588 W; 12 V; digital wave"],
    ["899-981-1050", "Microtek iMERLYN UPS 1050 (12V)", "Inverter", "iMERLYN UPS 1050", "900 VA / 725 W; 12 V; digital wave"],
    ["899-981-1250", "Microtek iMERLYN UPS 1250 (12V)", "Inverter", "iMERLYN UPS 1250", "1100 VA / 850 W; 12 V; digital wave"],
    ["899-981-1850", "Microtek iMERLYN UPS 1850 (24V)", "Inverter", "iMERLYN UPS 1850", "1600 VA / 1275 W; 24 V; digital wave"],
    ["899-A31-0850", "Microtek iMERLYN UPS 850 Pure Sine Wave (12V)", "Inverter", "iMERLYN UPS 850", "700 VA / 560 W; 12 V; pure sine wave"],
    ["899-A31-1050", "Microtek iMERLYN UPS 1050 Pure Sine Wave (12V)", "Inverter", "iMERLYN UPS 1050", "900 VA / 725 W; 12 V; pure sine wave"],
  ].map(([sku, name, category, model, specifications]) => microtekProduct(
    sku!, name!, category!, model!, specifications!, microtekInverters,
  )),
  ...[
    ["899-BA2-0150", "Microtek Dura Long M1502424JT", "M1502424JT", "150 Ah; jumbo tubular; ADC technology"],
    ["899-BA2-T160", "Microtek Dura Strong M1603624TT", "M1603624TT", "160 Ah; tall tubular; ADC technology"],
    ["899-BA2-TT18", "Microtek Dura Strong M1803624TT", "M1803624TT", "180 Ah; tall tubular; ADC technology"],
    ["899-BA2-TT20", "Microtek Dura Strong M2003624TT", "M2003624TT", "200 Ah; tall tubular; ADC technology"],
    ["899-BA2-T220", "Microtek Dura Strong M2203624TT", "M2203624TT", "220 Ah; tall tubular; ADC technology"],
    ["899-BA2-0250", "Microtek Dura Strong M2503624TT", "M2503624TT", "250 Ah; tall tubular; ADC technology"],
  ].map(([sku, name, model, specifications]) => microtekProduct(
    sku!, name!, "Inverter Battery", model!, specifications!, microtekBatteries,
  )),
  ...[
    ["12XL2.5L-C", 2.5, "80 x 70 x 105", "Left layout"],
    ["XLTZ4A", 4, "113 x 70 x 85", "Left layout"],
    ["XLTZ5A", 5, "113 x 70 x 105", "Left layout"],
    ["XLTZ6", 5, "113 x 70 x 105", "Left layout"],
    ["12XL5L-B", 5, "121 x 60 x 130", "Left layout"],
    ["XLTZ7", 6, "113 x 70 x 130", "Left layout"],
    ["12XL7B-B", 7, "151 x 60 x 130", "Right layout"],
    ["XLTZ9", 8, "150 x 87 x 105", "Right layout"],
    ["12XL9-B", 9, "136 x 75 x 139", "Right layout"],
    ["XLTX14", 12, "150 x 87 x 146", "Left layout"],
    ["12XL14L-A2", 14, "136 x 90 x 166", "Left layout"],
  ].map(([model, capacity, dimensions, layout]) => exideBattery(
    "Xplore Two-Wheeler Battery", model as string, capacity as number,
    dimensions as string, exideXplore, layout as string,
  )),
  ...[
    ["DRIVE35L", 35, "197 x 129 x 227", "Car / LCV"],
    ["DRIVE40LBH", 40, "197 x 137 x 227", "Car / LCV"],
    ["DRIVE45L", 45, "238 x 129 x 227", "Car / LCV"],
    ["DRIVE45R", 45, "238 x 129 x 227", "Car / LCV; right layout"],
    ["DRIVE700R", 65, "260 x 173 x 225", "Car / SUV / commercial"],
    ["DRIVE80L", 80, "305 x 173 x 225", "Car / SUV / commercial"],
    ["DRIVE88L", 88, "410 x 176 x 235", "Car / SUV / commercial"],
    ["DRIVE100L", 100, "410 x 176 x 235", "Car / SUV / commercial"],
    ["DRIVE130R", 130, "505 x 182 x 257", "Commercial; right layout"],
    ["DRIVE150R", 150, "508 x 222 x 257", "Commercial; right layout"],
    ["DRIVE180R", 180, "521 x 278 x 270", "Commercial; right layout"],
  ].map(([model, capacity, dimensions, fitment]) => exideBattery(
    "Drive Automotive Battery", model as string, capacity as number,
    dimensions as string, exideDrive, fitment as string,
  )),
  ...[
    ["DR40LBH", 40, "197 x 137 x 227"],
    ["DR700F", 65, "260 x 173 x 225"],
    ["DRDIN50", 50, "207 x 175 x 190"],
    ["DRDIN60", 60, "242 x 175 x 190"],
    ["DRDIN66", 66, "278 x 175 x 190"],
  ].map(([model, capacity, dimensions]) => exideBattery(
    "Dare SUV Battery", model as string, capacity as number,
    dimensions as string, exideDare, "SUV range",
  )),
  ...[
    ["RIDE35L", 35, "197 x 129 x 227", "Left layout"],
    ["RIDE35R", 35, "197 x 129 x 227", "Right layout"],
    ["RIDE45L", 45, "237 x 128 x 227", "Left layout"],
    ["RIDE700L", 65, "260 x 173 x 225", "Left layout"],
    ["RIDE700R", 65, "260 x 173 x 225", "Right layout"],
    ["RIDE700LF", 65, "260 x 173 x 225", "Left layout"],
    ["RIDE700RF", 65, "260 x 173 x 225", "Right layout"],
  ].map(([model, capacity, dimensions, layout]) => exideBattery(
    "Ride Commercial Vehicle Battery", model as string, capacity as number,
    dimensions as string, exideRide, layout as string,
  )),
  ...[
    ["KI75TF", 75, "305 x 173 x 225", "Right layout"],
    ["KI80T", 80, "305 x 173 x 225", "Left layout"],
    ["KI88T", 88, "410 x 176 x 233", "Left layout"],
    ["KI88TLH", 88, "410 x 176 x 213", "Left layout"],
    ["KI90H29L", 90, "358 x 173 x 234", "Left layout"],
    ["KI99T", 99, "410 x 176 x 233", "Left layout"],
  ].map(([model, capacity, dimensions, layout]) => exideBattery(
    "Jai Kisan Tractor Battery", model as string, capacity as number,
    dimensions as string, exideJaiKisan, layout as string,
  )),
  ...["1 L", "4 L", "10 L", "20 L"].map((packSize) => paintProduct(
    `Asian Paints Tractor Sparc ${packSize}`,
    "TRACTOR-SPARC",
    "Interior Paint",
    tractorSparc,
    packSize,
  )),
  paintProduct("Asian Paints Tractor Aqualock", "TRACTOR-AQUALOCK", "Interior Distemper", "https://www.asianpaints.com/paint-products/interior-wall-paints/plain-finishes/tractor-aqualock.html"),
  paintProduct("Asian Paints Tractor Uno", "TRACTOR-UNO", "Interior Distemper", "https://www.asianpaints.com/paint-products/interior-wall-paints/plain-finishes/tractor-uno.html"),
  paintProduct("Asian Paints TruCare Sparc Interior Primer - Water Thinnable", "TRUCARE-SPARC-INTERIOR-PRIMER", "Interior Primer", "https://www.asianpaints.com/products/undercoats/sparc-interior-primer.html"),
  paintProduct("Asian Paints Acrylic Wall Putty", "ACRYLIC-WALL-PUTTY", "Wall Putty", "https://www.asianpaints.com/paint-products/interior-wall-paints/plain-finishes/acrylic-wall-putty.html"),
  paintProduct("Asian Paints SmartCare Damp Block 2K - Prime", "SMARTCARE-DAMP-BLOCK-2K-PRIME", "Waterproofing", "https://www.asianpaints.com/waterproofing-products/smartcare-damp-block-2k-prime-1a60.html"),
  paintProduct("Asian Paints WoodTech Polyester Gold", "WOODTECH-POLYESTER-GOLD", "Wood Coating", "https://www.asianpaints.com/content/ap/en/home/products/wood-finish/wood-listing/woodtech-polyester-gold.html"),
  ...[
    ["Activ 4T", "20W-40"],
    ["Activ 4T", "10W-30"],
    ["Activ Cruise", "20W-50"],
    ["Activ Cruise", "15W-50"],
    ["Activ Scooter", "10W-30"],
    ["Activ Scooter", "5W-30"],
    ["POWER1", "10W-30"],
    ["POWER1", "10W-40"],
    ["POWER1", "15W-40"],
    ["POWER1 Cruise", "15W-50"],
    ["POWER1 Cruise", "20W-50"],
  ].map(([name, grade]) => oilProduct(name!, grade!, "Two-Wheeler Engine Oil", name!.startsWith("Activ") ? castrolActiv : castrolPower1)),
  oilProduct("GTX", "20W-50", "Car Engine Oil", castrolGtx),
  oilProduct("GTX Diesel", "15W-40", "Diesel Engine Oil", castrolGtx),
  oilProduct("GTX Ultraclean", "5W-30", "Car Engine Oil", castrolGtx),
];