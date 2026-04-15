# View current environment variables
Get-ChildItem Env:PATH

# Add new environment variable
New-Item -Path Env: -Name "MY_VARIABLE" -Value "my_value"




# Path: scripts/powershell/EnvironmentVariables.ps1
# Add directory to PATH environment variable
$env:PATH += ";S:\Repos\GitHub\csa-inabox\scripts\PowerShell"

# Call script using environment variable
.\scripts\PowerShell\
EnvironmentVariables.ps1




#delete environment variable
Remove-Item -Path Env: -Name "dbt-env"

#update environment variable
Set-Item -Path Env: -Name "MY_VARIABLE" -Value "my_value"

#remove from PATH environment variable
$env:PATH = $env:PATH.Replace(";S:\Repos\GitHub\csa-inabox\scripts\PowerShell", "")