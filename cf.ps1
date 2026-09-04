param(
    [Parameter(Position = 0)]
    [ValidateSet("verify", "list", "add", "update", "remove")]
    [string]$Action,
    [string]$Type = "A",
    [string]$Name,
    [string]$Content,
    [switch]$Proxied,
    [int]$TTL = 300
)

$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing .env file at $envPath" }
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([^=]+)=(.*)$') {
        Set-Variable -Name $matches[1].Trim() -Value $matches[2].Trim() -Scope Script
    }
}

$Headers = @{ Authorization = "Bearer $CF_API_TOKEN"; "Content-Type" = "application/json" }

function Get-ZoneId {
    $resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" -Headers $Headers
    if (-not $resp.success -or $resp.result.Count -eq 0) { throw "Zone lookup failed: $($resp.errors | ConvertTo-Json)" }
    return $resp.result[0].id
}

function Get-Fqdn([string]$n) {
    if (-not $n -or $n -eq "@" -or $n -eq $CF_ZONE) { return $CF_ZONE }
    return "$n.$CF_ZONE"
}

switch ($Action) {
    "verify" {
        # /user/tokens/verify rejects narrowly zone-scoped tokens even when valid;
        # a zone lookup is the reliable check for tokens scoped to DNS+Zone read only.
        $resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" -Headers $Headers
        if ($resp.success -and $resp.result.Count -gt 0) {
            Write-Host "Token OK. Zone '$CF_ZONE' -> $($resp.result[0].id) (status: $($resp.result[0].status))"
        } else {
            $resp | ConvertTo-Json -Depth 5
        }
    }
    "list" {
        $zoneId = Get-ZoneId
        $resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?per_page=100" -Headers $Headers
        $resp.result | Select-Object type, name, content, proxied, ttl, id | Format-Table -AutoSize
    }
    "add" {
        if (-not $Name -or -not $Content) { throw "Need -Name and -Content" }
        $zoneId = Get-ZoneId
        $fqdn = Get-Fqdn $Name
        $body = @{ type = $Type; name = $fqdn; content = $Content; ttl = $TTL; proxied = [bool]$Proxied } | ConvertTo-Json
        $resp = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" -Headers $Headers -Body $body
        $resp | ConvertTo-Json -Depth 5
    }
    "update" {
        if (-not $Name -or -not $Content) { throw "Need -Name and -Content" }
        $zoneId = Get-ZoneId
        $fqdn = Get-Fqdn $Name
        $existing = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=$Type&name=$fqdn" -Headers $Headers
        if ($existing.result.Count -eq 0) { throw "No existing $Type record found for $fqdn" }
        $recordId = $existing.result[0].id
        $body = @{ type = $Type; name = $fqdn; content = $Content; ttl = $TTL; proxied = [bool]$Proxied } | ConvertTo-Json
        $resp = Invoke-RestMethod -Method Put -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$recordId" -Headers $Headers -Body $body
        $resp | ConvertTo-Json -Depth 5
    }
    "remove" {
        if (-not $Name) { throw "Need -Name" }
        $zoneId = Get-ZoneId
        $fqdn = Get-Fqdn $Name
        $existing = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=$Type&name=$fqdn" -Headers $Headers
        if ($existing.result.Count -eq 0) { throw "No existing $Type record found for $fqdn" }
        $recordId = $existing.result[0].id
        $resp = Invoke-RestMethod -Method Delete -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$recordId" -Headers $Headers
        $resp | ConvertTo-Json -Depth 5
    }
    default {
        Write-Host "Usage:"
        Write-Host "  .\cf.ps1 verify"
        Write-Host "  .\cf.ps1 list"
        Write-Host "  .\cf.ps1 add    -Name jelly -Content 1.2.3.4 [-Type A] [-Proxied] [-TTL 300]"
        Write-Host "  .\cf.ps1 update -Name jelly -Content 1.2.3.4 [-Type A] [-Proxied]"
        Write-Host "  .\cf.ps1 remove -Name jelly [-Type A]"
    }
}
