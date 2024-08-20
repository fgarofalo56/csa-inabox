# Manage libraries for Apache Spark in Azure Synapse:  https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries


#If you want to use wget, download and install from: https://gnuwin32.sourceforge.net/packages/wget.htmhttps://gnuwin32.sourceforge.net/packages/wget.htm
#If you do not want to install wget, you can download the Azure Synapse env from the Azure-Samples repo:  https://github.com/Azure-Samples/Synapse/blob/main/Spark/Python/Synapse-Python38-CPU.yml


# Need Miniforge: https://github.com/conda-forge/miniforge
# when installing add path to Miniforge3 if not add run commands from the Miniforge cmd prompt
#download:  https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
#Install Miniforge on windows.  To call conda you can you _conda in the scripts and commands
# Download the installer, run in a cmd prompt: start /wait "" Miniforge3-Windows-x86_64.exe /InstallationType=JustMe /RegisterPython=0 /S /D=%UserProfile%\Miniforge3


# Azure Synapse samples env: 
# Need to also have env setup for Azure Synapse:  https://github.com/Azure-Samples/Synapse/blob/main/Spark/Python/base_environment.yml

# Download environment yml files
#Base environment
wget https://github.com/Azure-Samples/Synapse/blob/main/Spark/Python/base_environment.yml

#Synapse-Python38-CPU env
wget https://github.com/Azure-Samples/Synapse/blob/main/Spark/Python/Synapse-Python38-CPU.yml


# Activate base conda environment: path to conda needs to be added to env vars.
# conda activate

# Ref to conda docs: https://conda.io/projects/conda/en/latest/user-guide/tasks/manage-channels.html

# Install GCC and G++ for conda env on windows
# https://anaconda.org/conda-forge/m2w64-gcc-libs
conda install conda-forge::m2w64-gcc-libs

#Install g++ (https://anaconda.org/conda-forge/clangxx)
conda install conda-forge::clangxx

# Setup Conda Environments:
# Base Azure Synapse Python setup
conda env create -n synapse-base-env -f base_environment.yml

# One-time Azure Synapse Python setup
conda env create -n synapse-env38 -f Synapse-Python38-CPU.yml

# One-time Azure Synapse Python setup
conda env create -n synapse-env_310 -f Synapse-Python310-CPU.yml



#Steps for identifying the wheel files needed for download when useing Synapse Spark Runtimes
    #Resource Links for Refrence and download locations for GitHub Repos:
        #https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries
        #Spark Pythong Runtime Yaml files: https://github.com/Azure-Samples/Synapse/tree/main/Spark/Python
        #Miniforge: https://github.com/conda-forge/miniforge
            #SH file for Miniforge: https://github.com/conda-forge/miniforge/tree/main

#1. Create a conda env based on the Synapse Spark Runtime
    #A. This should be done on a Linux machine or WSL
    #B. Download the Miniforge SH file
    #C. Run the SH file to install Miniforge
    #D. Add the path to Miniforge to the PATH
    #E. Download the Synapse Spark Runtime Yaml file
    #F. Update env to include gcc g++

# In WSL env cd to the directory where you want to configure the conda env
#Example
cd /mnt/c/Users/username/Documents/Projects/Synapse-DEP
#Run the following commands
wget https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-aarch64.sh
wget https://raw.githubusercontent.com/Azure-Samples/Synapse/main/Spark/Python/Synapse-Python310-CPU.yml

sudo bash Miniforge3-Linux-aarch64.sh -b -p /usr/lib/miniforge3
export PATH="/usr/lib/miniforge3/bin:$PATH"
sudo apt-get -yq install gcc g++
conda env create -n <name-your-env> -f Synapse-Python10-CPU.yml 
source activate <name-your-env>

#2. Run the following command to get the list of packages and wheel files needed for download
    #A. Create a requirements file with the packages you want to install

#Example
echo "pandas==1.3.3" > req-packages.txt
echo "numpy==1.21.2" >> req-packages.txt
echo "scipy==1.7.3" >> req-packages.txt

#Run the following command
pip wheel --wheel-dir=./wheels -r req-packages.txt > pip_output.txt

#3. Loop through the wheel files and download them
    #A. Loop throught the list of wheel files and download them using a download script that takes the path of the wheel file as an argument and downloads them to a specified directory on the local machine or a storage account in Azure
    #B. Run the download script
    #C. Package the wheel files into a tar.gz file
    #D. Upload the tar.gz file to a storage account in Azure

#Example
#Download script
#download.sh
#!/bin/bash
while IFS= read -r line
do
    wget $line
done < "$1"

#Run the download script
chmod +x download.sh
./download.sh pip_output.txt

#Package the wheel files into a tar.gz file
tar -czvf wheels.tar.gz wheels

#Upload the tar.gz file to a storage account in Azure
#Use the Azure CLI to upload the tar.gz file to a storage account in Azure
#Example
az storage blob upload --account-name <storage-account-name> --container-name <container-name> --file wheels.tar.gz --name wheels.tar.gz

#4. Download the tar.gz file to the Synapse Spark Runtime
    #A. Use the Azure CLI to download the tar.gz file to the Synapse Spark Runtime
    #B. Use the Azure CLI to extract the tar.gz file on the Synapse Spark Runtime
    #C. Use the Azure CLI to install the wheel files on the Synapse Spark Runtime

#Example
#Download the tar.gz file to the Synapse Spark Runtime
az storage blob download --account-name <storage-account-name> --container-name <container-name> --file wheels.tar.gz --name wheels.tar.gz

#Extract the tar.gz file on the Synapse Spark Runtime
tar -xzvf wheels.tar.gz

#Install the wheel files on the Synapse Spark Runtime
pip install --no-index --find-links=./wheels -r req-packages.txt

#5. Use the installed packages in the Synapse Spark Runtime
    #A. Use the installed packages in the Synapse Spark Runtime by importing them in the Python code
    #B. Run the Python code in the Synapse Spark Runtime

#Example
#Import the installed packages in the Python code
import pandas as pd
import numpy as np
import scipy as sp

#Run the Python code in the Synapse Spark Runtime
#Use the Azure Synapse Spark Pool to run the Python code in the Synapse Spark Runtime

#6. Clean up the environment
    #A. Clean up the environment by deleting the conda env and the wheel files
    #B. Use the Azure CLI to delete the tar.gz file from the storage account in Azure

#Example
#Delete the conda env and the wheel files
conda env remove -n <name-your-env>
rm -rf wheels wheels.tar.gz

#Delete the tar.gz file from the storage account in Azure
az storage blob delete --account-name <storage-account-name> --container-name <container-name> --name wheels.tar.gz

#7. Conclusion
    #A. In this guide, we have shown how to manage libraries for Apache Spark in Azure Synapse by creating a conda env based on the Synapse Spark Runtime, getting the list of packages and wheel files needed for download, downloading the wheel files, packaging the wheel files into a tar.gz file, uploading the tar.gz file to a storage account in Azure, downloading the tar.gz file to the Synapse Spark Runtime, installing the wheel files on the Synapse Spark Runtime, using the installed packages in the Synapse Spark Runtime, and cleaning up the environment.
    







## Other useful commands
#Azure Synapse Spark Runtimes: https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-version-support
# https://github.com/microsoft/synapse-spark-runtime
#Azure Synapse Spark Libraries: https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries


#use this for ref:  https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries
#then get list of wheel files that are needed for download

#Spark Env files for downloads:
    #https://github.com/Azure-Samples/Synapse/blob/main/Spark/Python/


pip wheel --wheel-dir=./wheels -r req-packages.txt > pip_output.txt

run python script to get list of packages and wheel files


download structutre should look somthing like this:  
pip download --only-binary :all: --no-cache-dir --no-deps --dest wheel/ great_expectations==0.18.15