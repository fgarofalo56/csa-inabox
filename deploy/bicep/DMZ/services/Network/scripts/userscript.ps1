    function GetExistingVNetLinks {
      param([string[]] $zones, [string] $ResourceGroupName)
       foreach ($zone in $zones) {
                  $existingLinks += Get-AzPrivateDnsVirtualNetworkLink -ZoneName $zone -ResourceGroupName $ResourceGroupName | Select Name, ZoneName, ResourceGroupName, VirtualNetworkId, VirtualNetworkLinkState
          }
         $existingLinks | ConvertTo-Json
      }
      
    $output =  GetExistingVNetLinks -zones $zones -ResourceGroupName $ResourceGroupName -Verbose
    Write-Output $output
    $DeploymentScriptOutputs = @{}
    $DeploymentScriptOutputs['linked'] = $output
