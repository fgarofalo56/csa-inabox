# Description: Create a new service principal with a self-signed certificate and assign the service principal the Contributor role on a resource group.
# Cert: Name 
$certName = "FedCivATU-Comercial-Cert"
$path = "S:\DevResources\Certs"
$certExportPath = "$path\$certName"
# Generate a self-signed certificate, create a service principal with the certificate, and assign the service principal the Contributor role on a resource group.
$cert = New-SelfSignedCertificate -Subject "CN=$certName" -CertStoreLocation "Cert:\CurrentUser\My" -KeyExportPolicy Exportable -KeySpec Signature

# Get the password for the certificate
$certSecurePassword = Read-Host -Prompt "Enter Password" -AsSecureString


# Export the certificate to a .pfx file 
Export-PfxCertificate -Cert $cert -FilePath "$certExportPath.pfx" -Password $certSecurePassword 
$pfx = Get-PfxData -FilePath "$certExportPath.pfx" -Password $certSecurePassword

# Export the certificate to a .cer file
Export-Certificate -Cert $cert -FilePath "$certExportPath.cer"


# Conver CER File to PEM format
$certPassword = Read-Host -Prompt "Enter Password"
openssl pkcs12 -in "$certExportPath.pfx" -out "$certExportPath.pem" -nodes -password pass:$certPassword 
# Read Pem File
$certPem = Get-Content "$certExportPath.pem"
$certPem


#If you need to use plain txt for any Reason
# $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword))

# Convert the certificate to base64
$certBytes = [System.IO.File]::ReadAllBytes("$certExportPath.cer")
$certBase64 = [System.Convert]::ToBase64String($certBytes)
# Set SP Name
$servicePrincipalName = "FedCivATU-demoSub-Deploy"

# Create a service principal with the certificate (New SP)
$sp = New-AzADServicePrincipal -DisplayName $servicePrincipalName -CertValue $certBase64

# Update-AzADServicePrincipal to add certificate to existing SP

$sp = Get-AzADServicePrincipal -DisplayName $servicePrincipalName

$sp
$keyConfig = @{
    # 'CustomKeyIdentifier' = $cert.Thumbprint
    'Key'         = $certBytes
    'usage'       = 'Verify'
    'Type'        = 'AsymmetricX509Cert'
    'DisplayName' = 'FedCivATU-Comercial-Cert'
}

$certConfig = New-Object -TypeName "Microsoft.Azure.PowerShell.Cmdlets.Resources.MSGraph.Models.ApiV10.MicrosoftGraphKeyCredential" -Property $keyConfig
$certConfig

Update-AzADServicePrincipal -ObjectId $sp.Id -KeyCredential $certConfig

#Get Built in Roles 
Get-AzRoleDefinition | Where-Object Name -Like '*read*' | Select-Object -Property Name

# Get the subscription ID
$subId = Get-AzSubscription | Select-Object -ExpandProperty Id

# Assign the service principal the Contributor role on a resource group
$resourceGroupName = "rg-alz-dev-logging"

# Create Resource group
New-AzResourceGroup -Name $resourceGroupName -Location "East US 2"


$scope = "/subscriptions/$subId/resourceGroups/$resourceGroupName"
$roleDefinitionName = "Contributor"
New-AzRoleAssignment -ObjectId $sp.Id -RoleDefinitionName $roleDefinitionName -Scope $scope

# Assign Service Pricipal Subscription Level Roles:  Reader
$roleDefinitionName = "Reader"
New-AzRoleAssignment -ObjectId $sp.Id -RoleDefinitionName $roleDefinitionName -Scope "/subscriptions/$subId"

# Verify the service principal's role assignments
Get-AzRoleAssignment -ObjectId $sp.Id

                                    
