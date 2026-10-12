"""Download Acer's NitroSense package from the Microsoft Store's servers (no Windows or account needed).

usage: fetch-nitrosense.py OUTPUT.msix

Looks the app up in the Store catalog, asks the Windows Update service that serves Store apps for the current
x64 package, and downloads it. The update service uses Microsoft's own root CA, pinned in
data/microsoft-root-2011.pem. The package itself is served over plain HTTP, so callers must verify what they use:
extract-acer-assets.py checks every file against data/acer-assets.tsv.
"""
import html
import json
import os
import re
import ssl
import sys
import urllib.request

FAMILY = "ULICTekInc.NitroSenseforNotebook_nt9dgb7efx6bt"
CATALOG = ("https://displaycatalog.mp.microsoft.com/v7.0/products/lookup?alternateId=PackageFamilyName"
           f"&value={FAMILY}&market=US&languages=en-US&fieldsTemplate=details")
SERVICE = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx"
ROOT_CA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "microsoft-root-2011.pem")
NS = 'xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"'
DEVICE = ("BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;FlightRing=Retail;AttrDataVer=21;"
          "InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;App=WU;AppVer=10.0.22621.900;"
          "OSArchitecture=AMD64;OSSkuId=48;IsFlightingEnabled=0;TelemetryLevel=3;OSVersion=10.0.22621.900;"
          "DeviceFamily=Windows.Desktop;")
# Update IDs a stock Windows client reports as installed; the service expects them before it lists app packages.
INSTALLED = [1, 2, 3, 11, 19, 544, 549, 2359974, 2359977, 5169044, 8788830, 23110993, 23110994, 54341900,
             54343656, 59830006, 59830007, 59830008, 60484010, 62450018, 62450019, 62450020, 66027979, 66053150,
             97657898, 98822896, 98959022, 98959023, 98959024, 98959025, 98959026, 104433538, 104900364,
             105489019, 117765322, 129905029, 130040031, 132387090, 132393049, 133399034, 138537048, 140377312,
             143747671, 158941041, 158941042, 158941043, 158941044, 159123858, 159130928, 164836897, 164847386,
             164848327, 164852241, 164852246, 164852252, 164852253]
ENVELOPE = (
    '<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
    '<s:Header><a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/'
    'ClientWebService/{action}</a:Action><a:MessageID>urn:uuid:5754a03d-d8d5-489f-b24d-efc31b3fd32d</a:MessageID>'
    '<a:To s:mustUnderstand="1">{to}</a:To><o:Security s:mustUnderstand="1" '
    'xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    '<Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
    '<Created>2024-01-01T00:00:00.000Z</Created><Expires>2044-01-01T00:00:00.000Z</Expires></Timestamp>'
    '<wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" '
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" '
    'xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">'
    '<TicketType Name="AAD" Version="1.0" Policy="MBI_SSL"></TicketType></wuws:WindowsUpdateTicketsToken>'
    '</o:Security></s:Header><s:Body>{body}</s:Body></s:Envelope>')


def soap(action, body, url=SERVICE):
    request = urllib.request.Request(url, ENVELOPE.format(action=action, to=url, body=body).encode(),
                                     {"Content-Type": "application/soap+xml; charset=utf-8"})
    context = ssl.create_default_context(cafile=ROOT_CA)
    return html.unescape(urllib.request.urlopen(request, timeout=60, context=context).read().decode())


def category_id():
    catalog = json.load(urllib.request.urlopen(CATALOG, timeout=60))
    for product in catalog.get("Products", []):
        for sku in product.get("DisplaySkuAvailabilities", []):
            data = sku["Sku"]["Properties"].get("FulfillmentData") or {}
            if data.get("WuCategoryId"):
                return data["WuCategoryId"]
    sys.exit("NitroSense was not found in the Microsoft Store catalog")


def package_update(category):
    reply = soap("GetCookie", f"<GetCookie {NS}><oldCookie></oldCookie><lastChange>2015-10-21T17:01:07Z"
                              "</lastChange><currentTime>2024-01-01T00:00:00Z</currentTime>"
                              "<protocolVersion>1.40</protocolVersion></GetCookie>")
    cookie = re.search(r"<EncryptedData>(.*?)</EncryptedData>", reply).group(1)
    installed = "".join(f"<int>{i}</int>" for i in INSTALLED)
    reply = soap("SyncUpdates", (
        f"<SyncUpdates {NS}><cookie><Expiration>2045-01-01T00:00:00Z</Expiration><EncryptedData>{cookie}"
        f"</EncryptedData></cookie><parameters><ExpressQuery>false</ExpressQuery><InstalledNonLeafUpdateIDs>"
        f"{installed}</InstalledNonLeafUpdateIDs><OtherCachedUpdateIDs></OtherCachedUpdateIDs>"
        "<SkipSoftwareSync>false</SkipSoftwareSync><NeedTwoGroupOutOfScopeUpdates>true"
        f"</NeedTwoGroupOutOfScopeUpdates><FilterAppCategoryIds><CategoryIdentifier><Id>{category}</Id>"
        "</CategoryIdentifier></FilterAppCategoryIds><TreatAppCategoryIdsAsInstalled>true"
        "</TreatAppCategoryIdsAsInstalled><AlsoPerformRegularSync>false</AlsoPerformRegularSync><ComputerSpec/>"
        "<ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended"
        "</XmlUpdateFragmentType></XmlUpdateFragmentTypes><Locales><string>en-US</string></Locales>"
        "</ExtendedUpdateInfoParameters><ClientPreferredLanguages><string>en-US</string>"
        "</ClientPreferredLanguages><ProductsParameters><SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>"
        f"<DeviceAttributes>{DEVICE}</DeviceAttributes><CallerAttributes>Interactive=1;IsSeeker=0;"
        "</CallerAttributes><Products/></ProductsParameters></parameters></SyncUpdates>"))
    for xml in re.findall(r"<Xml>(.*?)</Xml>", reply, re.S):
        identity = re.search(r'UpdateIdentity UpdateID="([^"]+)" RevisionNumber="(\d+)"', xml)
        moniker = re.search(r'PackageMoniker="([^"]+)"', xml)
        if identity and moniker and moniker.group(1).startswith("ULICTekInc.NitroSense") and "_x64_" in moniker.group(1):
            return moniker.group(1), identity.groups()
    sys.exit("the Microsoft Store did not list a NitroSense package")


def download_url(update_id, revision):
    reply = soap("GetExtendedUpdateInfo2", (
        f"<GetExtendedUpdateInfo2 {NS}><updateIDs><UpdateIdentity><UpdateID>{update_id}</UpdateID>"
        f"<RevisionNumber>{revision}</RevisionNumber></UpdateIdentity></updateIDs><infoTypes>"
        "<XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes>"
        f"<deviceAttributes>{DEVICE}</deviceAttributes></GetExtendedUpdateInfo2>"), f"{SERVICE}/secured")
    urls = re.findall(r"<Url>(.*?)</Url>", reply)
    if not urls:
        sys.exit("the Microsoft Store did not return a download link")
    return urls[0]


def main():
    output = sys.argv[1]
    name, (update_id, revision) = package_update(category_id())
    url = download_url(update_id, revision)
    print(f"Downloading {name} from Microsoft")
    with urllib.request.urlopen(url, timeout=60) as response, open(output, "wb") as out:
        total = int(response.headers.get("Content-Length", 0))
        done = 0
        while chunk := response.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total and sys.stdout.isatty():
                print(f"\r  {done >> 20} / {total >> 20} MB", end="", flush=True)
    if sys.stdout.isatty():
        print()


if __name__ == "__main__":
    main()
